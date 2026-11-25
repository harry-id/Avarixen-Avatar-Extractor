#!/usr/bin/env python3
"""Worker-heap OOM probe: status, body, headers, and pool recovery.

Starts the production-like container with the output-face budget bypassed
(MAX_OUTPUT_FACES huge) and a small worker heap (MAX_WORKER_HEAP_MB) so a
conversion exhausts the worker's V8 heap. Reports the exact status, body and
response headers (notably Retry-After) for three sequential requests, then
restarts the container WITHOUT the bypass and confirms a normal conversion
succeeds (the pool/worker is healthy again).

Usage:
    python3 tools/perf/oom_probe.py [user]

Environment: same as verify.py. NOT part of `npm test`.
"""
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
USER = sys.argv[1] if len(sys.argv) > 1 else "5004"


def docker(*args, **kw):
    return subprocess.run(["docker", *args], capture_output=True, text=True, **kw)


def start(extra_env=None):
    docker("rm", "-f", NAME)
    env = ["-e", "NODE_ENV=production", "-e", "HOST=0.0.0.0", "-e", f"PORT={PORT}",
           "-e", "CORS_ORIGINS=http://localhost:3001", "-e", "TRUST_PROXY=false",
           "-e", "LOG_REQUESTS=false", "-e", "AAE_LOG_FILE=false"]
    if extra_env:
        for k, v in extra_env.items():
            env += ["-e", f"{k}={v}"]
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


def convert():
    url = f"http://127.0.0.1:{PORT}/api/roblox/convert/{USER}/glb?rig=1&subdivision=4"
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            body = r.read()
            return {"status": r.status, "bytes": len(body),
                    "headers": dict(r.headers)}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "body": e.read()[:300].decode("utf-8", "replace"),
                "headers": dict(e.headers)}
    except Exception as e:
        return {"error": str(e)}


def main():
    print("=== phase 1: budget bypassed, small worker heap ===")
    start({"MAX_OUTPUT_FACES": "999999999", "MAX_WORKER_HEAP_MB": "256"})
    if not wait_up():
        print("no start")
        docker("rm", "-f", NAME)
        return
    for i in (1, 2, 3):
        r = convert()
        # trim headers to the interesting ones but keep all for the first
        print(json.dumps({"request": i, **r}))

    print("=== phase 2: bypass removed (fresh container, normal env) ===")
    start(None)
    if not wait_up():
        print("no start (phase 2)")
        docker("rm", "-f", NAME)
        return
    r = convert()
    print(json.dumps({"request": "recovery", **r}))
    docker("rm", "-f", NAME)


if __name__ == "__main__":
    main()