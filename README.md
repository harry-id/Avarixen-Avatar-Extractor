# Avarixen Avatar Extractor

Avarixen Avatar Extractor (AAE) is a web-based Roblox avatar extraction tool that retrieves avatar models, previews them in 3D, and exports them as ZIP files containing OBJ, MTL, and texture files.

## Prerequisites

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

## Internationalization

The frontend supports **Indonesian (`id`)** and **English (`en`)**:

- A language selector in the header lets users switch languages.
- The choice is saved to `localStorage` (`aae_lang`) and persists across reloads.
- Defaults to the browser language (Indonesian if `id`, otherwise English).
- Backend API error messages also honor the `Accept-Language` header, so they match the selected frontend language.

## Notes

- The frontend targets the backend at `http://localhost:3000` for local dev (auto-detected on localhost). For other deployments, set `window.__AAE_BACKEND_URL__` before the app script or serve the API behind the same origin.
- Downloaded assets are cached under `downloads/<userId>/`.
- Do not commit real API keys; keep secrets in `backend/.env`.
- Rate limiting is in-memory per process (resets on restart). For multi-instance production deployments, use a shared store or gateway/WAF rate limiting.
