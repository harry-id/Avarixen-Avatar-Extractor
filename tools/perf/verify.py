#!/usr/bin/env python3
"""Docker conversion matrix runner for the AAE backend.

Runs the real container (image avarixen/aae-backend:local) with production-like
limits and measures wall time, peak container memory (cgroup memory.peak) and
/api/health latency while conversions run.

Usage:
    python3 tools/perf/verify.py '<json cases>'

Each case: {"label","user","fmt","conc","sub"?,"separate"?,"extra_env"?}
  fmt: glb | gltf | fbx
  conc: number of simultaneous convert requests
  sub: subdivision level (default 4)
  separate: glTF separate-files mode (adds &separate=1)
  extra_env: object of extra -e KEY=VAL for the container

Environment:
    AAE_REPO       repo root (default: two levels up from this file)
    AAE_DOWNLOADS  host downloads dir mounted into the container
    AAE_PORT       host/container port (default 7850)
    AAE_CPUS       --cpus value (default 1, matching compose.yaml)
    AAE_MEMORY     --memory value (default 1g, matching compose.yaml)

This script is NOT part of `npm test`; it is a manual, repeatable harness.
"""
import concurrent.futures
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

REPO = os.environ.get("AAE_REPO") or os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..")
)
PORT = int(os.environ.get("AAE_PORT", "7850"))
NAME = "aae-verify"
IMG = "avarixen/aae-backend:local"
CPUS = os.environ.get("AAE_CPUS", "1")
MEMORY = os.environ.get("AAE_MEMORY", "1g")
DOWNLOADS = os.environ.get(
    "AAE_DOWNLOADS", "/tmp/opencode/aae-verify/downloads"
)


def docker(*args, **kw):
    return subprocess.run(["docker", *args], capture_output=True, text=True, **kw)


def start(extra_env=None):
    docker("rm", "-f", NAME)
    env = [
        "-e", "NODE_ENV=production", "-e", "HOST=0.0.0.0", "-e", f"PORT={PORT}",
        "-e", "CORS_ORIGINS=http://localhost:3001", "-e", "TRUST_PROXY=false",
        "-e", "LOG_REQUESTS=false", "-e", "AAE_LOG_FILE=false",
    ]
    if extra_env:
        for k, v in extra_env.items():
            env += ["-e", f"{k}={v}"]
    cmd = [
        "run", "-d", "--name", NAME, f"--memory={MEMORY}", f"--cpus={CPUS}",
        "-p", f"127.0.0.1:{PORT}:{PORT}",
        "-v", f"{REPO}/backend:/home/container/opt/aae/backend:ro",
        "-v", f"{DOWNLOADS}:/home/container/opt/aae/downloads",
        *env, IMG, "node", "server.js",
    ]
    r = docker(*cmd)
    if r.returncode != 0:
        print("RUN FAIL", r.stderr)
        sys.exit(1)


def stop():
    docker("rm", "-f", NAME)


def wait_up(timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{PORT}/api/health", timeout=2
            ) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def health_during(stop_flag, samples):
    while not stop_flag[0]:
        r = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{time_total}",
             f"http://127.0.0.1:{PORT}/api/health"],
            capture_output=True, text=True, timeout=6,
        )
        if r.returncode == 0:
            try:
                samples.append(float(r.stdout.strip()) * 1000)
            except Exception:
                samples.append(5000.0)
        else:
            samples.append(5000.0)
        time.sleep(0.1)


def run_case(label, user, fmt, conc, sub=4, separate=False, extra_env=None):
    start(extra_env)
    if not wait_up():
        logs = docker("logs", NAME).stderr + docker("logs", NAME).stdout
        print(json.dumps({"label": label, "error": "no start",
                          "logs": logs[-800:]}))
        stop()
        return
    stop_flag = [False]
    hs = []
    ht = threading.Thread(target=health_during, args=(stop_flag, hs), daemon=True)
    ht.start()
    t0 = time.time()

    def one():
        url = (f"http://127.0.0.1:{PORT}/api/roblox/convert/{user}/{fmt}"
               f"?rig=1&subdivision={sub}")
        if separate:
            url += "&separate=1"
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                data = r.read()
                return {"status": r.status, "bytes": len(data)}
        except urllib.error.HTTPError as e:
            return {"status": e.code,
                    "body": e.read()[:200].decode("utf-8", "replace")}
        except Exception as e:
            return {"error": str(e)}

    with concurrent.futures.ThreadPoolExecutor(max_workers=conc) as ex:
        results = list(ex.map(lambda _: one(), range(conc)))
    wall = time.time() - t0
    stop_flag[0] = True
    ht.join(timeout=2)
    try:
        peak_b = int(
            docker("exec", NAME, "cat", "/sys/fs/cgroup/memory.peak").stdout.strip()
        )
    except Exception:
        peak_b = 0
    peak_mb = round(peak_b / 1048576, 1) if peak_b else None
    hs_sorted = sorted(hs)
    p50 = round(hs_sorted[len(hs_sorted) // 2], 1) if hs_sorted else None
    hmax = round(max(hs), 1) if hs else None
    print(json.dumps({
        "label": label, "cpus": CPUS, "conc": conc, "wall_s": round(wall, 2),
        "peak_mem_mb": peak_mb, "health_p50_ms": p50, "health_max_ms": hmax,
        "health_samples": len(hs), "results": results,
    }))
    stop()


if __name__ == "__main__":
    cases = json.loads(sys.argv[1])
    for c in cases:
        run_case(**c)