# tools/perf — Docker performance harness

Manual, repeatable measurement scripts for the AAE backend. These are **not**
part of `npm test`; run them by hand against the real container image
`avarixen/aae-backend:local`.

## Prerequisites

- Docker, with the image built: `docker build -t avarixen/aae-backend:local .`
- A downloads fixture directory with pre-cached avatars, one subdir per user id
  (each containing `avatar.json`, `avatar.obj`, `avatar.mtl`). The default path
  is `/tmp/opencode/aae-verify/downloads` and can be overridden with
  `AAE_DOWNLOADS`. Users used by the scripts: `5001` (GLB/glTF ~500K),
  `5002` (FBX ~400K), `5004` (r15-cap, used for the OOM probe).
- `curl` and `python3` on the host.

## Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `AAE_REPO` | repo root | Path mounted read-only at `/home/container/opt/aae/backend` |
| `AAE_DOWNLOADS` | `/tmp/opencode/aae-verify/downloads` | Host downloads dir |
| `AAE_PORT` | `7850` | Host/container port |
| `AAE_CPUS` | `1` | `--cpus` (matches `compose.yaml`) |
| `AAE_MEMORY` | `1g` | `--memory` (matches `compose.yaml`) |

## Scripts

### `verify.py` — conversion matrix

Runs a JSON list of cases and prints one JSON line per case with wall time,
peak container memory (cgroup `memory.peak`), and `/api/health` p50/max.

```bash
python3 tools/perf/verify.py '[
  {"label":"glb-500k-c1","user":"5001","fmt":"glb","conc":1,"sub":4},
  {"label":"glb-500k-c2","user":"5001","fmt":"glb","conc":2,"sub":4},
  {"label":"fbx-400k-c2","user":"5002","fmt":"fbx","conc":2,"sub":4}
]'
```

Case fields: `label`, `user`, `fmt` (`glb`|`gltf`|`fbx`), `conc`, optional
`sub` (default 4), `separate` (glTF separate-files), `extra_env` (object of
extra container env).

### `cancel_sample.py` — cancellation releases CPU/memory

Starts a conversion, aborts the client socket mid-flight, then samples
`memory.current` and CPU% every 500 ms for 10 s, and finally runs a normal
conversion to prove the slot was released.

```bash
python3 tools/perf/cancel_sample.py 5001 glb
```

### `oom_probe.py` — worker OOM status/headers and recovery

Starts the container with the output-face budget bypassed and a small worker
heap, fires three conversions (reporting status, body, headers incl.
`Retry-After`), then restarts without the bypass to confirm recovery.

```bash
python3 tools/perf/oom_probe.py 5004
```

### `starve_repro.py` — conversion-slot starvation

Fires N concurrent conversions for one user plus one for a different user, then
a two-user control. Shows a single user can fill the global conversion slots +
queue and starve another user (503).

```bash
python3 tools/perf/starve_repro.py 10
```

## Notes

- Peak memory is read from the container's cgroup `memory.peak`, which is the
  high-water mark for the container's lifetime (reset each `docker run`).
- Health latency is sampled with `curl` from the host during the run; a few
  hundred samples per case is normal.
- The container runs as root here for simplicity; `compose.yaml` runs as UID
  999. CPU/memory limits match production.