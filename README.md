# Avarixen Avatar Extractor

Avarixen Avatar Extractor (AAE) is a web-based Roblox avatar extraction tool that retrieves avatar models, previews them in 3D, and exports them as ZIP files containing OBJ, MTL, and texture files.

## Try the demo

**[Try out the demo →](https://harry-id.github.io/Avarixen-Avatar-Extractor/)**

The live demo is hosted on GitHub Pages, with the API running on a server in Europe.

## Preview

<img src="preview.png" alt="Avarixen Avatar Extractor preview" width="480">

## Requirements

- **Node.js 18+** (backend relies on the built-in `fetch` API)
- npm

## Project structure

- `backend/` – Express API server (Roblox lookup, avatar metadata/download)
- `frontend/` – Express static server + Three.js viewer UI
- `downloads/` – generated avatar assets served by the frontend at `/assets/...`

## Setup

### 1. Install dependencies

```bash
cd backend
npm install

cd ../frontend
npm install
```

### 2. Configure the backend

Create `backend/.env` from the example and set your Roblox API key:

```bash
cp backend/.env.example backend/.env
```

`backend/.env`:

```env
ROBLOX_API_KEY=your_roblox_api_key_here
# PORT=3000
# CORS_ORIGINS=http://localhost:3001
```

### Create a Roblox API key

1. Go to https://create.roblox.com/dashboard/credentials?activeTab=ApiKeysTab
2. Click **Create API Key**
3. Enter a name (e.g. `AAE Avatar Extractor`)
4. Under **Access Permissions**, add:
   - `thumbnails:read` — required for avatar metadata
   - `users.advanced:read` — optional, for user lookup
5. Click **Save & Generate**
6. Copy the key into `backend/.env` as `ROBLOX_API_KEY`

Notes:
- `ROBLOX_API_KEY` is required for avatar metadata and download endpoints.
- `CORS_ORIGINS` is optional (comma-separated). If unset, CORS is permissive by default; set explicit origins for production.

### 3. Run (single command)

From the repository root, install everything and start both servers at once:

```bash
# One-time setup (installs root + backend + frontend dependencies)
npm run setup

# Start backend + frontend together (single command)
npm start
```

- Backend: `http://localhost:3000`
- Frontend: `http://localhost:3001`

Press `Ctrl+C` to stop both servers.

> Tip: you still need to create `backend/.env` from `backend/.env.example` and set your `ROBLOX_API_KEY` before starting.

Open `http://localhost:3001`, enter a Roblox username, and load/export the avatar.

## Languages

The frontend supports **Indonesian (`id`)** and **English (`en`)**:

- A language selector in the header lets users switch languages.
- The choice is saved to `localStorage` (`aae_lang`) and persists across reloads.
- Defaults to the browser language (Indonesian if `id`, otherwise English).
- Backend API error messages also honor the `Accept-Language` header, so they match the selected frontend language.

## Model Conversion

The download control is a split button: clicking the main button downloads OBJ (ZIP) directly, and the adjacent arrow opens a dropdown with the other formats.

| Format | Endpoint | Notes |
|--------|----------|-------|
| OBJ (ZIP) | Frontend-side | Bundles OBJ, MTL, and textures into a ZIP |
| GLB | `GET /api/roblox/convert/:userId/glb` | Binary GLTF, backend-converted via `@gltf-transform/core` |
| GLTF | `GET /api/roblox/convert/:userId/gltf` | JSON GLTF, backend-converted via `@gltf-transform/core` |
| FBX | `GET /api/roblox/convert/:userId/fbx` | Binary FBX 7.4, written by the built-in exporter (`backend/fbx-exporter.js`) with embedded textures |

The conversion requires the avatar to be downloaded first (so the OBJ/MTL/texture files exist under `downloads/<userId>/`).

Auto-rig (`?rig=1`) is available for GLB, GLTF, and FBX. The FBX writer emits a real skeleton (`LimbNode` bones, `Cluster` skin deformers, `BindPose`) using the same joints/weights as the glTF exporters, so rigged FBX imports with an armature in Blender/Unity/Unreal. Add `?moreJoints=1` for the R6 extra bones.

Account info shows the detected **avatar type** (`R6` / `R15`, or `Unknown` when the avatar has no body groups). R6 rigs also get **hand bones** (`Left Hand` / `Right Hand`) at the bottom of each arm so accessories can be attached there.

With an R6 avatar and Auto-rig enabled, the **Advanced settings** section (below the checkboxes) reveals **More joints**, which adds extra bones: **hands** (always), plus **lower arms (elbows)**, **lower legs (knees)**, **feet**, and a **waist** so the torso can bend (`HumanoidRootPart → Waist → Torso`). Enabling **More joints** locks **Mesh quality** to **High** / **Extreme** (Default/Low/Medium are disabled) and defaults to **High**. The same section contains the global **Mesh quality** presets for GLB/GLTF/FBX:

| Preset | Subdivision |
|---|---|
| Default | none |
| Low | 1 |
| Medium | 2 |
| High | 3 |
| Extreme | 4 |

Subdivision refines the mesh while preserving UVs and normals, and is capped at ~3.5M faces for cross-device safety. It applies to the **body only** — the **head** and all `Handle*` accessories keep their original density. The OBJ export is always the original downloaded geometry. Limb weights use a smoothstep falloff so elbows/knees bend without the linear-skinning pinch.

Unsupported options are **disabled (grayed out)** rather than hidden: OBJ disables both *Separate assets* and *Auto-rig*; GLB disables *Separate assets*; GLTF and FBX enable both.

OBJ files are normalized during download: the body (excluding accessories) is centred on X/Z with the feet at Y=0, and every `g` group is mirrored as an `o` object. Player groups are renamed to body parts (`Head`, `Torso`, `LeftArm`, `RightArm`, `LeftLeg`, `RightLeg`, or the R15 names); `Handle*` accessories keep their names.

Every GLB, GLTF, and FBX export keeps the body parts as separate objects under a node named after the avatar's display name — there is no merged `character_mesh` anymore. **Separate assets** (the checkbox above the download buttons) only chooses packaging: off returns one self-contained file with embedded textures; on returns a ZIP with external assets for **GLTF** (`.gltf` + `.bin` + textures) and **FBX** (`.fbx` + textures). **GLB is always a single embedded binary**, and OBJ is generated client-side as a ZIP of parts + textures. OBJ has no collection concept, so Blender lists the parts as separate flat objects.

GLB/GLTF/FBX are centred on the body (accessories are excluded from the offsets) with the feet at Y=0. FBX is written with Blender's axis/unit preset (`UnitScaleFactor=100`) so it imports upright and at the right scale.

None of these formats can store a Blender collection: the exported root is a parent empty. To get folder semantics, select the imported parts and use **M → New Collection** in Blender.

Downloaded files are named `{safeName}_{userId}.{format}` (e.g. `Roblox_11159567260.fbx`), where `safeName` is the Roblox display name/username with filesystem-illegal characters replaced.

## Catalog (experimental)

Switch the header to **Catalog** mode to search the Roblox catalog and export 3D items (accessories, hair, clothing, etc.) without entering a user ID.

- Search by keyword/category, browse thumbnail results, and click any item.
- The backend fetches Roblox's 3D asset thumbnail (`assets-thumbnail-3d`), downloads the OBJ/MTL/textures, and reuses the same conversion pipeline as avatars.
- GLB/GLTF/FBX/OBJ downloads, mesh-quality presets, and separate-assets all work. Auto-rig and More joints are disabled because catalog items have no skeleton.
- Coverage is partial: bundles and Studio models/meshes have no 3D thumbnail (`state: Error`). Those would need the raw asset-delivery path (not implemented).

Requires `ROBLOX_API_KEY` with the `thumbnail:read` scope (the same scope avatars use).

## Compatibility

Exports are tested with **Blender 3.6** and **Prisma3D 3.3.5** — covering OBJ, GLB, GLTF, and FBX in standard, separate-assets, and rigged modes. See [tests.md](tests.md) for the full test matrix and per-format notes.

## Notes

- The frontend targets the backend at `http://localhost:3000` for local dev (auto-detected on localhost). For other deployments, set `window.__AAE_BACKEND_URL__` before the app script or serve the API behind the same origin.
- Downloaded assets are cached under `downloads/<userId>/`. The Reload button re-requests the download endpoint and reloads the preview with a cache-busting query, so it always uses fresh files.
- Roblox avatar metadata is retried up to 5 times (1.5 s apart) when the avatar is not ready yet; authentication errors fail immediately.
- Do not commit real API keys; keep secrets in `backend/.env`.
- Rate limiting is in-memory per process (resets on restart). Set `TRUST_PROXY` (e.g. `1` or `true`) in `backend/.env` when running behind a reverse proxy so the real client IP is used. For multi-instance production deployments, use a shared store or gateway/WAF rate limiting.

## Tests

```bash
cd backend
npm test
```

The backend test suite uses the built-in `node:test` runner and covers OBJ/MTL parsing, body-part mapping, texture planning, i18n, and FBX serialization.

