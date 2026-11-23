# Avarixen Avatar Extractor — API Reference

REST API for the AAE backend. It resolves Roblox users, downloads/caches avatar assets, and converts them to GLB/GLTF/FBX.

- **Base URL (production):** `https://api.harrycore.web.id`
- **Base URL (local dev):** `http://localhost:3000`
- **Content type:** `application/json` for requests/responses (conversions return binary).
- **Localization:** error `message` fields honor the `Accept-Language` header (`en`, `id`).

---

## Quick start

```bash
# 1. Resolve a username -> user ID
curl -s -X POST https://api.harrycore.web.id/api/roblox/user \
  -H 'Content-Type: application/json' \
  -d '{"username":"builderman"}'

# 2. Download/cache the avatar assets
curl -s "https://api.harrycore.web.id/api/roblox/download/156"

# 3. Convert to GLB
curl -s -o avatar.glb "https://api.harrycore.web.id/api/roblox/convert/156/glb"
```

---

## Conventions

### Success / error shape
All JSON endpoints return:
```json
{ "success": true, ... }      // success
{ "success": false, "message": "Human readable message" }   // error
```

### Status codes
| Code | Meaning |
|---|---|
| `200` | OK |
| `400` | Bad request (invalid ID, empty username, unsupported format) |
| `404` | Not found (unknown user, OBJ not cached) |
| `413` | Input or asset exceeds a configured size limit |
| `422` | Conversion failed (e.g. auto-rig failed) |
| `429` | Rate limited (`Retry-After` header) |
| `500` | Server/config error (missing API key, write failure) |
| `502` | Upstream Roblox failure |
| `503` | Conversion/download/parts queue full (retry later) |
| `504` | Upstream timeout |
| `507` | Cache quota or free-disk threshold reached |

### Rate limiting
`/api/*` is limited to **60 requests/minute per IP**. Exceeding it returns `429` with a `Retry-After` header (seconds). `/assets/*` and `/` are not rate-limited. In production, configure `TRUST_PROXY=cloudflare` behind Cloudflare Tunnel or a trusted hop/CIDR list; `TRUST_PROXY=true` is rejected.

### Resource limits
Downloads are admitted by `MAX_CONCURRENT_DOWNLOADS` / `MAX_DOWNLOAD_QUEUE` and bounded by `MAX_ASSET_BYTES`, `MAX_AVATAR_BYTES`, and `DOWNLOAD_TIMEOUT_MS`. Conversion and explorer parsing are admitted by `MAX_CONCURRENT_CONVERSIONS` / `MAX_CONVERSION_QUEUE` and `MAX_CONCURRENT_PARTS` / `MAX_PARTS_QUEUE`. OBJ inputs are limited by `MAX_OBJ_BYTES`, `MAX_OBJ_VERTICES`, and `MAX_OBJ_FACES`. Oversized inputs return `413`; exhausted queues return `503`.

### CORS
Controlled by `CORS_ORIGINS` (comma-separated). If unset in development, CORS is permissive with a warning. Production requires explicit origins.

---

## Endpoints

### `GET /`
Service info.

**200**
```json
{ "status": "online", "name": "Avarixen Avatar Extractor", "version": "1.2.1-beta" }
```

---

### `GET /api/health`
Lightweight health probe.

**200**
```json
{ "status": "online" }
```

---

### `POST /api/roblox/user`
Resolve a Roblox username to a user ID.

**Request**
```json
{ "username": "builderman" }
```

**200**
```json
{
  "success": true,
  "user": { "id": 156, "username": "builderman", "displayName": "builderman" }
}
```

**Errors**
| Status | Message key |
|---|---|
| `400` | `user.empty` (blank), `user.invalid` (too long) |
| `404` | `user.not_found` |
| `502` | `user.upstream_failed` |
| `504` | `user.timeout` |
| `500` | `user.lookup_failed` |

---

### `GET /api/roblox/avatar/:userId`
Fetch raw Roblox avatar-3D metadata (thumbnail image URL).

**200**
```json
{ "success": true, "avatar": { "...": "raw Roblox avatar-3d payload" } }
```

**Errors**
| Status | Message key |
|---|---|
| `400` | `avatar.invalid_user_id` |
| `500` | `avatar.not_configured` (no API key) |
| `502` | `avatar.upstream_failed` |
| `504` | `avatar.timeout` |
| `500` | `avatar.failed` |

---

### `GET /api/roblox/download/:userId`
Download the avatar's OBJ/MTL/textures and cache them under `downloads/<userId>/`. **Must be called before `/convert`.**

**200**
```json
{
  "success": true,
  "message": "Avatar downloaded successfully.",
  "textureCount": 3,
  "files": [
    "/assets/156/avatar.obj",
    "/assets/156/avatar.mtl",
    "/assets/156/texture1.png"
  ],
  "totalSize": 2043322,
  "rigType": "R6",
  "robloxType": "R6",
  "compatibility": { "status": "compatible", "matched": 6, "expected": 6, "missing": [] }
}
```
`rigType` and `robloxType` are `"R6"`, `"R15"`, or `null`. `compatibility` describes geometry-based body-part matching.

**Errors**
| Status | Message key |
|---|---|
| `400` | `download.invalid_user_id` |
| `413` | `download.too_large` |
| `500` | `download.not_configured`, `download.write_failed`, `download.failed` |
| `502` | `download.upstream_avatar_failed`, `download.metadata_failed`, `download.metadata_invalid`, `download.metadata_incomplete` |
| `503` | `download.busy` (`Retry-After`) |
| `504` | `download.timeout` |
| `507` | `download.no_space` |

---

### `GET /assets/:userId/:file`
Static avatar files (served with CORS). Files: `avatar.obj`, `avatar.mtl`, `texture1.png`, `texture2.png`, …

Used by the 3D viewer and the client-side OBJ download.

---

### `GET /api/roblox/parts/:userId`
Part/group metadata for the model explorer sidebar.

**200**
```json
{
  "success": true,
  "rigType": "R6",
  "groups": [
    { "name": "Torso", "vertices": 44, "faces": 12, "type": "body", "part": "Torso" }
  ]
}
```
`rigType` may be `null`; `part` may be `null` for accessories.

**Errors**
| Status | Message key |
|---|---|
| `400` | `convert.invalid_user_id` |
| `404` | `convert.no_obj` |
| `413` | `convert.too_large` |
| `500` | `convert.failed` |
| `503` | `parts.busy` (analysis queue full; `Retry-After`) |

---

### `GET /api/roblox/convert/:userId/:format`
Convert a cached avatar to a 3D format.

**Path**
| Param | Values |
|---|---|
| `userId` | numeric Roblox user ID |
| `format` | `glb`, `gltf`, `fbx` |

**Query parameters**
| Param | Values | Description |
|---|---|---|
| `rig` | `1` | Auto-rig (GLB/GLTF/FBX) |
| `moreJoints` | `1` | R6 extra bones (hands, elbows, knees, feet, waist); requires `rig=1` |
| `subdivision` | `0`–`4` | Mesh quality: 0 Minimal (Default), 1 Low, 2 Medium, 3 High, 4 Extreme |
| `separate` | `1` | ZIP with external `.bin`/textures (GLTF/FBX only; ignored for GLB) |
| `compat` | `1` | Alias for `separate` |
| `bendAccessories` | `0`/`1` | Skin multi-part R15 clothing (requires `rig=1`) |
| `name` | string | Root object name (defaults to `Avatar`) |

**Responses**
| Format | Success | `separate=1` |
|---|---|---|
| `glb` | `model/gltf-binary` (`.glb`) | n/a (always single file) |
| `gltf` | `model/gltf+json` (`.gltf`) | `application/zip` (`.gltf` + `.bin` + textures) |
| `fbx` | `application/octet-stream` (`.fbx`) | `application/zip` (`.fbx` + textures) |

Files are sent with `Content-Disposition: attachment; filename="<userId>.<ext>"`.

**Errors**
| Status | Message key |
|---|---|
| `400` | `convert.invalid_user_id`, `convert.unsupported` |
| `404` | `convert.no_obj` (download first) |
| `422` | `convert.rig_failed` (auto-rig error when `rig=1`) |
| `503` | `convert.busy` (conversion queue full; retry later) |
| `500` | `convert.failed` |

`HEAD` requests to `/download` and `/convert` return `405`; these endpoints have side effects.

### Example — parallel conversions
```bash
for fmt in glb gltf fbx; do
  curl -s -o "/tmp/avatar.$fmt" \
    "https://api.harrycore.web.id/api/roblox/convert/156/$fmt?rig=1&subdivision=2" &
done
wait
```

---

## Typical flow
1. `POST /api/roblox/user` → `user.id`
2. `GET /api/roblox/download/:id` → cache OBJ/MTL/textures
3. (optional) `GET /api/roblox/parts/:id` → explorer data
4. `GET /api/roblox/convert/:id/:format` → download the model

## Notes
- `/convert` requires a prior `/download` for that user (files cached under `downloads/<id>/`).
- Cached downloads are deleted after `DOWNLOADS_TTL_HOURS` (default **24h**) or when `DOWNLOADS_MAX_BYTES` is exceeded (default **5 GiB**; `0` explicitly means unlimited). `MIN_FREE_DISK_BYTES` blocks new downloads when free space is low.
- Conversion is CPU-bound and bounded by `MAX_CONCURRENT_CONVERSIONS` / `MAX_CONVERSION_QUEUE`; parallel requests share the same process/cores.
- `subdivision` refines the **body only** (Head + `Handle*` accessories excluded). Capped at ~3.5M faces.
- `rig`/`moreJoints` apply to GLB/GLTF/FBX; OBJ is always the original geometry.