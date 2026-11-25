#!/usr/bin/env python3
"""Reproduce conversion-slot starvation by a single user.

The convert route acquires a GLOBAL conversion slot (conversionLimiter.acquire)
before taking the per-user lock (withUserLock). A single user firing many
same-user conversions therefore holds both slots (one running, one blocked on
the per-user lock) and fills the queue, so a DIFFERENT user is starved.

Phase A: 10 concurrent conversions for one user + 1 for a different user.
Phase B (control): 1 conversion each for two different users, concurrently.

Usage:
    python3 tools/perf/starve_repro.py [n]

Environment: same as verify.py. NOT part of `npm test`.
"""
import concurrent.futures
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

REPO = os.environ.get("AAE_REPO") or os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..")
)
PORT = int(os.environ.get("AAE_PORT", "7850"))
NAME = "aae-verify"
IMG = "avarixen/aae-backend:local"
CPUS = os.environ.get("AAE_CPUS", "1")
MEMORY = os.environ.get("AAE_MEMORY", "1g")
DOWNLOADS = os.environ.get("AAE_DOWNLOADS", "/tmp/opencode/aae-verify/downloads")
N = int(sys.argv[1]) if len(sys.argv) > 1 else 10


def docker(*args, **kw):
    return subprocess.run(["docker", *args], capture_output=True, text=True, **kw)


def start():
    docker("rm", "-f", NAME)
    env = ["-e", "NODE_ENV=production", "-e", "HOST=0.0.0.0", "-e", f"PORT={PORT}",
           "-e", "CORS_ORIGINS=http://localhost:3001", "-e", "TRUST_PROXY=false",
           "-e", "LOG_REQUESTS=false", "-e", "AAE_LOG_FILE=false"]
    cmd = ["run", "-d", "--name", NAME, f"--memory={MEMORY}", f"--cpus={CPUS}",
           "-p", f"127.0.0.1:{PORT}:{PORT}",
           "-v", f"{REPO}/backend:/home/container/opt/aae/backend:ro",
           "-v", f"{DOWNLOADS}:/home/container/opt/aae/downloads",
           *env, IMG, "node", "server.js"]
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


def convert(user, sub=4):
    url = (f"http://127.0.0.1:{PORT}/api/roblox/convert/{user}/glb"
           f"?rig=1&subdivision={sub}")
    t0 = time.time()
    try:
        with urllib.request.urlopen(url, timeout=180) as r:
            n = len(r.read())
            return {"user": user, "status": r.status, "bytes": n,
                    "wall_s": round(time.time() - t0, 2)}
    except urllib.error.HTTPError as e:
        return {"user": user, "status": e.code,
                "body": e.read()[:120].decode("utf-8", "replace"),
                "wall_s": round(time.time() - t0, 2)}
    except Exception as e:
        return {"user": user, "error": str(e), "wall_s": round(time.time() - t0, 2)}


def main():
    # Phase A: starvation
    start()
    if not wait_up():
        print("no start")
        docker("rm", "-f", NAME)
        return
    print(f"=== phase A: {N} same-user (5001) + 1 other-user (5002) ===")
    with concurrent.futures.ThreadPoolExecutor(max_workers=N + 1) as ex:
        futs = [ex.submit(convert, "5001") for _ in range(N)]
        time.sleep(0.3)
        other = ex.submit(convert, "5002")
        results = [f.result() for f in futs] + [other.result()]
    same = [r for r in results if r["user"] == "5001"]
    oth = [r for r in results if r["user"] == "5002"][0]
    print(json.dumps({
        "phase": "A",
        "same_user_statuses": [r.get("status") for r in same],
        "same_user_wall_range": [min(r["wall_s"] for r in same),
                                 max(r["wall_s"] for r in same)],
        "other_user": oth,
    }))
    docker("rm", "-f", NAME)

    # Phase B: control (two different users)
    start()
    if not wait_up():
        print("no start (phase B)")
        return
    print("=== phase B (control): 1x5001 + 1x5002 concurrently ===")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        a = ex.submit(convert, "5001")
        b = ex.submit(convert, "5002")
        ra, rb = a.result(), b.result()
    print(json.dumps({"phase": "B", "5001": ra, "5002": rb}))
    docker("rm", "-f", NAME)


if __name__ == "__main__":
    main()