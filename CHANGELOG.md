# Changelog

All notable changes to Avarixen Avatar Extractor are documented here.

## [Unreleased]

### Added
- A `NODE_ENV=development` preset that applies friendlier local defaults for variables you have not set explicitly: `DOWNLOADS_TTL_HOURS=0` (disable the age sweep), `DOWNLOADS_MAX_BYTES=0` (no cache quota), `AAE_LOG_LEVEL=debug`, `LOG_REQUESTS=verbose`, `LOG_ASSETS=1`, effectively unlimited `RATE_LIMIT_MAX` and `DOWNLOAD_RATE_LIMIT_MAX`, and the stage profiler enabled (`AAE_PROFILE_STAGES=true`). Explicit variables always win, and a startup banner lists what was set and skipped. The preset does **not** change the SSRF allowlist, OBJ/body limits, `MAX_OUTPUT_FACES*`, worker heap/recycle limits, conversion/parts queues, or `DOWNLOADS_CACHE_FIRST_MS`.

### Fixed
- `DOWNLOADS_TTL_HOURS=0` now disables the cache age sweep (previously it fell back to the 24-hour default).

## 1.3.0-beta.2

### Added
- Conversions now run in a pool of worker threads, so a running export no longer blocks the event loop and health checks stay responsive. New environment variables: `MAX_WORKER_HEAP_MB`, `MAX_WORKER_RECYCLE_JOBS`, and `CONVERSION_DEADLINE_MS`.
- A stricter per-IP rate limit on the download endpoint, separate from the global API limit (`DOWNLOAD_RATE_LIMIT_MAX`, `DOWNLOAD_RATE_LIMIT_WINDOW_MS`).
- An optional, default-off cache-first download window (`DOWNLOADS_CACHE_FIRST_MS`) that can serve a recently cached avatar without re-fetching upstream.
- Startup recovery for downloads interrupted by a crash between the two commit renames.
- A Docker performance harness under `tools/perf/` (manual, not part of the automated test suite).
- An output-face budget that keeps memory bounded during mesh-quality subdivision (`MAX_OUTPUT_FACES`, `MAX_OUTPUT_FACES_FBX`).

### Changed
- A second simultaneous export or parts request from the same user now fails fast with `503` and a `Retry-After` header instead of queuing behind the first.
- Mesh-quality subdivision is capped by an output-face budget (500K for GLB/glTF, 400K for FBX); a requested subdivision level is lowered automatically when it would exceed the budget.
- Concurrent downloads for the same user are coalesced into a single upstream download.
- Recently used cache entries are protected from eviction for a configurable window (`DOWNLOADS_MIN_AGE_MS`).
- `/api/health` is exempt from the rate limiter, so uptime monitors are never throttled.

### Fixed
- The model explorer (parts) route no longer starves other users when one user has a long-running download or conversion.
- A deterministic worker out-of-memory now returns `503` without a `Retry-After` header (it is not transient).
- Interrupted downloads are restored on startup instead of being aged out.

### Security
- Metadata URLs are restricted to Roblox-owned hosts on the default HTTPS port (no non-default ports), preventing server-side request forgery.
- Asset hashes are validated against a strict URL-safe charset and length bound, preventing path/query injection into CDN URLs.

### Behavior changes
- A second simultaneous export or parts request from the same user now returns a fast `503` with `Retry-After` instead of queuing. (Per-tab the download button is disabled during a request, so normal single-tab use is unaffected; API clients and second tabs will see the 503.)
- Downloads are rate-limited per client IP (default 10 per minute; `DOWNLOAD_RATE_LIMIT_MAX` / `DOWNLOAD_RATE_LIMIT_WINDOW_MS`).
- Mesh-quality subdivision is capped by an output-face budget (500K GLB/glTF, 400K FBX), so a requested level can be lowered automatically.
- Conversion runs in worker threads. New environment variables: `MAX_WORKER_HEAP_MB`, `MAX_WORKER_RECYCLE_JOBS`, `CONVERSION_DEADLINE_MS`; a conversion that exceeds the deadline returns `504`.
- Recently used cache entries are protected from eviction (`DOWNLOADS_MIN_AGE_MS`); under quota pressure a new download can fail with `507` rather than evicting an active avatar.
- Startup recovery of interrupted downloads assumes ONE server instance per downloads volume (the per-user locks are in-process and the recovery renames files at startup).
- `/api/health` is exempt from the rate limiter.