#!/usr/bin/env python3
"""Download-protection verification under real Docker.

Runs a deterministic TLS mock of the Roblox/CDN endpoints (so downloads return
real 200s and upstream calls can be counted) and the real AAE backend container,
both on the host network. Verifies:

  1. Five simultaneous same-user downloads coalesce into ONE upstream sequence
     (mock avatar-3d counter == 1) and all five responses are 200.
  2. One source IP exceeding the download limit gets 429 while a second source
     IP (127.0.0.2) is unaffected.
  3. Under quota pressure, an actively-used avatar is NOT evicted by many new
     downloads (the new download fails 507 and the protected entry survives).

Environment:
    AAE_REPO       repo root (default: two levels up from this file)
    AAE_PORT       host/container port (default 7850)
    AAE_MEMORY     --memory (default 1g)
    AAE_CPUS       --cpus (default 1)
    AAE_DL_DIR     dir with cert + mock_upstream.js (default /tmp/opencode/aae-dl)

NOT part of `npm test`. Requires Docker and the ability to run a container as
root with --network host (to bind :443 for the mock).
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

REPO = os.environ.get("AAE_REPO") or os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..")
)
PORT = int(os.environ.get("AAE_PORT", "7850"))
MEMORY = os.environ.get("AAE_MEMORY", "1g")
CPUS = os.environ.get("AAE_CPUS", "1")
DL_DIR = os.environ.get("AAE_DL_DIR", "/tmp/opencode/aae-dl")
IMG = "avarixen/aae-backend:local"
MOCK = "aae-mock"
NAME = "aae-verify"
HOSTS = [
    "users.roblox.com", "thumbnails.roblox.com", "avatar.roblox.com",
    "tr.rbxcdn.com",
    "t0.rbxcdn.com", "t1.rbxcdn.com", "t2.rbxcdn.com", "t3.rbxcdn.com",
    "t4.rbxcdn.com", "t5.rbxcdn.com", "t6.rbxcdn.com", "t7.rbxcdn.com",
]


def docker(*args, **kw):
    return subprocess.run(["docker", *args], capture_output=True, text=True, **kw)


def ensure_mock_assets():
    """Generate the mock CA + server cert into DL_DIR if absent, and copy the
    mock server script there. Repeatable from a fresh checkout."""
    os.makedirs(DL_DIR, exist_ok=True)
    # Copy the mock server from the repo into DL_DIR (mounted at /mock).
    src = os.path.join(os.path.dirname(__file__), "mock_upstream.js")
    dst = os.path.join(DL_DIR, "mock_upstream.js")
    if os.path.abspath(src) != os.path.abspath(dst):
        with open(src) as f:
            data = f.read()
        with open(dst, "w") as f:
            f.write(data)
    ca = os.path.join(DL_DIR, "ca.pem")
    srv = os.path.join(DL_DIR, "server.pem")
    key = os.path.join(DL_DIR, "server.key")
    if os.path.exists(ca) and os.path.exists(srv) and os.path.exists(key):
        return
    san = os.path.join(DL_DIR, "san.cnf")
    domains = HOSTS
    alt = "\n".join(f"DNS.{i+1}={d}" for i, d in enumerate(domains))
    with open(san, "w") as f:
        f.write(
            "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n"
            "[dn]\nCN=Roblox Mock\n[v3]\nsubjectAltName=@alt\n"
            "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n"
            "extendedKeyUsage=serverAuth\n[alt]\n" + alt + "\n"
        )
    sh = (
        "set -e; cd " + DL_DIR + "; "
        "openssl genrsa -out ca.key 2048 2>/dev/null; "
        "openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.pem -subj '/CN=AAE Mock CA' 2>/dev/null; "
        "openssl genrsa -out server.key 2048 2>/dev/null; "
        "openssl req -new -key server.key -out server.csr -config san.cnf 2>/dev/null; "
        "openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 3650 -sha256 -extensions v3 -extfile san.cnf 2>/dev/null"
    )
    r = subprocess.run(["bash", "-c", sh], capture_output=True, text=True)
    if r.returncode != 0:
        print("cert generation failed:", r.stderr)
        sys.exit(1)


def start_mock():
    ensure_mock_assets()
    docker("rm", "-f", MOCK)
    cmd = ["run", "-d", "--name", MOCK, "--network", "host", "--user", "0:0",
           "-v", f"{DL_DIR}:/mock:ro", IMG, "node", "/mock/mock_upstream.js"]
    r = docker(*cmd)
    if r.returncode != 0:
        print("MOCK RUN FAIL", r.stderr)
        sys.exit(1)
    # wait for control server
    for _ in range(50):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8080/reset", timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            time.sleep(0.2)
    print("mock control not up:", docker("logs", MOCK).stdout + docker("logs", MOCK).stderr)
    sys.exit(1)


def counts():
    with urllib.request.urlopen("http://127.0.0.1:8080/", timeout=2) as r:
        return json.loads(r.read())


def reset_counts():
    with urllib.request.urlopen("http://127.0.0.1:8080/reset", timeout=2) as r:
        return json.loads(r.read())


def start_aae(extra_env=None):
    docker("rm", "-f", NAME)
    downloads = os.path.join(DL_DIR, "downloads")
    os.makedirs(downloads, exist_ok=True)
    env = ["-e", "NODE_ENV=production", "-e", "HOST=0.0.0.0", "-e", f"PORT={PORT}",
           "-e", "CORS_ORIGINS=http://localhost:3001", "-e", "TRUST_PROXY=false",
           "-e", "LOG_REQUESTS=false", "-e", "AAE_LOG_FILE=false",
           "-e", "ROBLOX_API_KEY=test-key",
           "-e", "NODE_EXTRA_CA_CERTS=/mock/ca.pem"]
    if extra_env:
        for k, v in extra_env.items():
            env += ["-e", f"{k}={v}"]
    addhost = []
    for h in HOSTS:
        addhost += ["--add-host", f"{h}:127.0.0.1"]
    cmd = ["run", "-d", "--name", NAME, "--network", "host", "--user", "0:0",
           f"--memory={MEMORY}", f"--cpus={CPUS}",
           "-v", f"{REPO}/backend:/home/container/opt/aae/backend:ro",
           "-v", f"{DL_DIR}:/mock:ro",
           "-v", f"{downloads}:/home/container/opt/aae/downloads",
           *addhost, *env, IMG, "node", "server.js"]
    r = docker(*cmd)
    if r.returncode != 0:
        print("RUN FAIL", r.stderr)
        sys.exit(1)


def wait_up(timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def http(method, path, local_ip=None, body=None):
    """HTTP request via curl, optionally bound to a loopback source IP."""
    url = f"http://127.0.0.1:{PORT}{path}"
    cmd = ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", method]
    if local_ip:
        cmd += ["--interface", local_ip]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", body]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.stdout.strip()


def get_body(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=30) as r:
        return r.status, json.loads(r.read())


def scenario_coalesce():
    start_aae()
    if not wait_up():
        print("no start (coalesce)")
        return
    reset_counts()
    import concurrent.futures
    # 5 simultaneous same-user downloads
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        futs = [ex.submit(get_body, "/api/roblox/download/4242") for _ in range(5)]
        results = [f.result() for f in futs]
    c = counts()
    statuses = [s for s, _ in results]
    print(json.dumps({
        "scenario": "coalesce",
        "statuses": statuses,
        "avatar3d_upstream_calls": c["avatar3d"],
        "metadata_calls": c["metadata"],
        "all_200": all(s == 200 for s in statuses),
    }))
    docker("rm", "-f", NAME)


def scenario_ratelimit():
    start_aae({"DOWNLOAD_RATE_LIMIT_MAX": "3", "DOWNLOAD_RATE_LIMIT_WINDOW_MS": "60000",
               "RATE_LIMIT_MAX": "100"})
    if not wait_up():
        print("no start (ratelimit)")
        return
    ip1 = [http("GET", "/api/roblox/download/4242", local_ip="127.0.0.1") for _ in range(5)]
    # different source IP has its own bucket
    ip2 = http("GET", "/api/roblox/download/4242", local_ip="127.0.0.2")
    print(json.dumps({
        "scenario": "ratelimit",
        "ip_127_0_0_1": ip1,
        "ip_127_0_0_2": ip2,
    }))
    docker("rm", "-f", NAME)


def scenario_quota():
    # Tiny quota; an actively-used (young) entry from another user must survive
    # while a flood of new-user downloads hits 507 instead of evicting it.
    downloads = os.path.join(DL_DIR, "downloads")
    # Clean any root-owned leftovers from a previous run (the container writes as
    # root, so the host user cannot rm them).
    docker("run", "--rm", "--user", "0:0", "-v", f"{DL_DIR}:/d", IMG,
           "sh", "-c", "rm -rf /d/downloads; mkdir -p /d/downloads")
    start_aae({"DOWNLOADS_MAX_BYTES": "1500", "DOWNLOADS_MIN_AGE_MS": "300000",
               "MAX_AVATAR_BYTES": "1000000", "MAX_ASSET_BYTES": "1000000",
               "DOWNLOAD_RATE_LIMIT_MAX": "1000"})
    if not wait_up():
        print("no start (quota)")
        return
    # Seed an active avatar for user 9001.
    s0, _ = get_body("/api/roblox/download/9001")
    # Flood new users; with the young 9001 protected, new downloads must 507
    # once the quota cannot be met without evicting protected entries.
    statuses = []
    for uid in range(9100, 9130):
        st = http("GET", f"/api/roblox/download/{uid}")
        statuses.append(st)
    # Eviction removes the whole user directory, so its presence means the
    # active avatar survived. (The dir is root-owned 0700; check the dir entry
    # itself, which is stat-able within the 0777 downloads parent.)
    survived = os.path.isdir(os.path.join(downloads, "9001"))
    n507 = statuses.count("507")
    n200 = statuses.count("200")
    print(json.dumps({
        "scenario": "quota",
        "seed_9001_status": s0,
        "flood_status_counts": {"200": n200, "507": n507,
                                "other": len(statuses) - n507 - n200},
        "active_9001_survived": survived,
    }))
    docker("rm", "-f", NAME)


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    start_mock()
    try:
        if which in ("all", "coalesce"):
            scenario_coalesce()
        if which in ("all", "ratelimit"):
            scenario_ratelimit()
        if which in ("all", "quota"):
            scenario_quota()
    finally:
        docker("rm", "-f", NAME)
        docker("rm", "-f", MOCK)