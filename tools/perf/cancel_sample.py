#!/usr/bin/env python3
"""Prove that a client abort mid-conversion releases CPU and memory.

Starts the production-like container, begins a large conversion, aborts the
client socket mid-flight, then samples container memory.current and CPU usage
every 500 ms for 10 s. Finally fires a normal conversion to prove the slot was
released and the worker is healthy.

Usage:
    python3 tools/perf/cancel_sample.py [user] [fmt]

Environment: same as verify.py (AAE_REPO, AAE_DOWNLOADS, AAE_PORT, AAE_CPUS,
AAE_MEMORY). NOT part of `npm test`.
"""
import json
import os
import socket
import subprocess
import sys
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
DOWNLOADS = os.environ.get("AAE_DOWNLOADS", "/tmp/opencode/aae-verify/downloads")
USER = sys.argv[1] if len(sys.argv) > 1 else "5001"
FMT = sys.argv[2] if len(sys.argv) > 2 else "glb"


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


def health():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=2) as r:
            return r.status
    except Exception as e:
        return str(e)


def mem_current_mb():
    try:
        b = int(docker("exec", NAME, "cat", "/sys/fs/cgroup/memory.current").stdout.strip())
        return round(b / 1048576, 1)
    except Exception:
        return None


def mem_stat_mb():
    """Return (anon_mb, file_mb) from memory.stat: anon = real process/RSS
    memory, file = reclaimable page cache."""
    try:
        out = docker("exec", NAME, "cat", "/sys/fs/cgroup/memory.stat").stdout
        vals = {}
        for line in out.splitlines():
            parts = line.split()
            if len(parts) == 2:
                vals[parts[0]] = int(parts[1])
        anon = round(vals.get("anon", 0) / 1048576, 1)
        file = round(vals.get("file", 0) / 1048576, 1)
        return anon, file
    except Exception:
        return None, None


def cpu_usage_usec():
    try:
        out = docker("exec", NAME, "cat", "/sys/fs/cgroup/cpu.stat").stdout
        for line in out.splitlines():
            if line.startswith("usage_usec"):
                return int(line.split()[1])
    except Exception:
        pass
    return None


def wait_up(timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if health() == 200:
            return True
        time.sleep(0.2)
    return False


def main():
    start()
    if not wait_up():
        print("no start")
        docker("rm", "-f", NAME)
        return
    # warm the worker pool with one quick health-proxied request is unnecessary;
    # begin a big conversion and abort.
    s = socket.create_connection(("127.0.0.1", PORT))
    req = (f"GET /api/roblox/convert/{USER}/{FMT}?rig=1&subdivision=4 "
           f"HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
    s.sendall(req.encode())
    time.sleep(1.5)
    try:
        s.recv(1024)
    except Exception:
        pass
    s.close()
    print(json.dumps({"event": "abort", "t": 0.0, "health": health()}))

    # sample every 500 ms for 10 s
    prev_cpu = cpu_usage_usec()
    prev_t = time.time()
    samples = []
    for i in range(1, 21):
        time.sleep(0.5)
        t = round(i * 0.5, 2)
        mem = mem_current_mb()
        anon, file = mem_stat_mb()
        cur_cpu = cpu_usage_usec()
        now = time.time()
        cpu_pct = None
        if cur_cpu is not None and prev_cpu is not None:
            dt = now - prev_t
            if dt > 0:
                cpu_pct = round((cur_cpu - prev_cpu) / 1e6 / dt * 100, 1)
        prev_cpu, prev_t = cur_cpu, now
        samples.append({"t": t, "mem_mb": mem, "anon_mb": anon, "file_mb": file,
                        "cpu_pct": cpu_pct, "health": health()})
        print(json.dumps(samples[-1]))

    # next request must succeed
    t0 = time.time()
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{PORT}/api/roblox/convert/{USER}/{FMT}?rig=1&subdivision=4",
            timeout=60,
        ) as r:
            b = len(r.read())
            st = r.status
    except Exception as e:
        st, b = str(e), 0
    print(json.dumps({"event": "post_abort_request", "status": st, "bytes": b,
                      "wall_s": round(time.time() - t0, 2), "health": health()}))
    docker("rm", "-f", NAME)


if __name__ == "__main__":
    main()