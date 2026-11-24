# Roblox Asset Type Reference (Research Prototype)

> **Status:** research prototype only. Nothing here is integrated into the
> Avarixen Avatar Extractor (AAE) runtime, and nothing in `backend/`,
> `frontend/` or production configuration was modified.
>
> **Snapshot date:** 2026-11-24. Roblox enums change over time; re-verify before
> relying on this data.

## 1. Scope

This directory documents three **separate** Roblox enumerations:

| Enum | Purpose | File |
|---|---|---|
| `Enum.AssetType` | General Roblox asset catalog (all asset kinds) | `asset-types.json` |
| `Enum.AvatarAssetType` | Asset types an avatar can equip | `avatar-asset-types.json` |
| `Enum.AccessoryType` | Accessory-only classification used by `HumanoidDescription` / `Accessory` | `accessory-types.json` |

They are intentionally **not merged**: their value spaces, semantics and API
usage differ. A fourth file, `aae-compatibility-draft.json`, records a
preliminary, AAE-specific classification kept deliberately separate from
Roblox's official categories.

## 2. Methodology

1. Retrieved the auto-generated enum YAML from the official
   `Roblox/creator-docs` repository (the source behind the Creator Hub docs).
2. Cross-checked names/values against the rendered Creator Hub page
   (`Enum.AssetType`) and against the Roblox API reference generated from the
   official client API dump (`robloxapi.github.io`), plus the raw API dump
   mirrored by `MaximumADHD/Roblox-Client-Tracker`.
3. Recorded numeric id, official name, official description (where published),
   classification, relevance flags, legacy names, source refs and a
   per-entry verification status.
4. Read AAE's pipeline source (not executed) to prepare the compatibility draft.

### Sources (all checked 2026-11-24)

Official:

- `https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/enums/AssetType.yaml`
- `https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/enums/AvatarAssetType.yaml`
- `https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/enums/AccessoryType.yaml`
- `https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/HumanoidDescription.yaml`
- `https://raw.githubusercontent.com/Roblox/creator-docs/main/content/en-us/reference/engine/classes/AccessoryDescription.yaml`
- `https://create.roblox.com/docs/reference/engine/enums/AssetType` (rendered page)

Generated / third-party mirrors of the official API dump:

- `https://robloxapi.github.io/ref/enum/AssetType.html`
- `https://robloxapi.github.io/ref/enum/AvatarAssetType.html`
- `https://robloxapi.github.io/ref/enum/AccessoryType.html`
- `https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/API-Dump.json`

## 3. Discrepancies found (documented, not silently resolved)

1. **`Enum.AssetType` count differs by source**
   - Creator docs YAML / Creator Hub: **64** items.
   - API reference + API dump: **67** items.
   - Extra entries only in the API dump:
     `AnimatedImage = 95`, `ComputeFunction = 96`, `SpawnEffect = 97`.
   - These three are included in `asset-types.json` with
     `verification: "api-reference-only"` and `description: null`.
2. **`Enum.AvatarAssetType` count differs by source**
   - Creator docs YAML: **44** items.
   - API reference + API dump: **45** items.
   - Extra entry only in the API dump: `SpawnEffect = 97`.
3. **`Enum.AccessoryType`** — both source families agree on **20** items.
4. **Removed / legacy identifiers**
   - `AssetType.VoxelFragment = 91` is present in older API history and removed
     from the current reference (recorded under `removedEntries`).
   - Legacy names: `TeeShirt` → `TShirt` (id 2), `TeeShirtAccessory` →
     `TShirtAccessory` (id 64), `AccessoryType.TeeShirt` → `TShirt` (id 9).
5. **Coverage gaps between enums**
   - `EarAccessory` (57) and `EyeAccessory` (58) exist in `AssetType` but are
     **not** members of `AvatarAssetType` and have **no** `AccessoryType`
     equivalent.
   - `DeathAnimation` (49) and `PoseAnimation` (56) exist in `AssetType` but
     are not members of `AvatarAssetType`.

## 4. Schema

Each of the three enum files uses the same shape:

```json
{
  "enum": "...",
  "robloxSummary": "...",
  "checkedAt": "2026-11-24",
  "entryCount": 0,
  "sources": [{ "id": "...", "title": "...", "url": "...", "authority": "...", "checkedAt": "..." }],
  "entries": [ /* per-enum fields, see below */ ],
  "removedEntries": [ /* removed/renamed identifiers, when applicable */ ]
}
```

Entry fields:

- `id` — numeric enum value (unique within the enum).
- `name` — official enum name.
- `description` — official summary, or `null` when not published.
- `category` — research classification (not an official Roblox field).
- `avatarRelevance` / `accessoryRelevance` — `high` | `medium` | `low` | `none`
  (research rubric; see §5).
- `inAvatarAssetType` — (AssetType only) membership in `Enum.AvatarAssetType`.
- `accessoryTypeId` — (AvatarAssetType only) mapped `Enum.AccessoryType` id or `null`.
- `mappedAvatarAssetTypeIds` — (AccessoryType only) reverse mapping.
- `legacyNames` — historical names reported by the API reference.
- `deprecated` — boolean flag.
- `sourceRefs` — which source families confirmed the entry.
- `verification` — `confirmed` (docs + API reference agree) or
  `api-reference-only` (newer than published docs).

## 5. Relevance rubric (research-defined)

- `high` — directly affects avatar geometry, textures or rigging.
- `medium` — relevant in some avatar contexts (e.g. bundles, mesh parts,
  thin layered accessories, gear, makeup).
- `low` — peripheral (thumbnails, general media).
- `none` — not avatar-related.

These flags are AAE research aids, not Roblox concepts.

## 6. AAE compatibility draft — scope and caveats

`aae-compatibility-draft.json` separates three concerns:

- `download` — whether the asset's content appears in the avatar OBJ/MTL/texture
  payload that AAE downloads (AAE downloads one avatar payload; it does not
  fetch individual assets by asset type).
- `export` — whether that content reaches converted outputs (FBX/GLB/GLTF).
- `autoRig` — whether AAE's R6/R15 rigging path handles the content.

Allowed values: `supported`, `experimental`, `unsupported`, `unknown`, plus
`not-applicable` where the concern cannot meaningfully apply (documented
extension of the requested classification set).

Important limitations:

- No runtime tests were executed for this draft; entries are **code-inspection
  based** (`backend/avatar-downloader.js`, `backend/convert.js`,
  `backend/fbx-exporter.js`, `backend/auto-rig.js`).
- Absence from an existing set is **not** treated as proof of unsupported.
  Unverified cases are marked `unknown`.
- Layered-clothing skinning is conditional (`bendAccessories` + R15 + handle
  groups), hence `experimental`.
- The pipeline excludes head groups from mesh-quality subdivision but still
  exports them.

## 7. Metadata available from Roblox avatar descriptions

- `HumanoidDescription` exposes body-part asset ids (`Head`, `Torso`, arms,
  legs), classic clothing (`Shirt`, `Pants`, `GraphicTShirt`, `Face`), animation
  ids (`Climb/Fall/Idle/Jump/Run/Swim/Walk`), `MoodAnimation`, scale/colour
  properties, and accessory lists (`Hat/Hair/Face/Neck/Shoulder/Front/Back/Waist`)
  plus `AccessoryBlob` (JSON with `AssetId`, `AccessoryType`, `Order`,
  optional `Puffiness`).
- `AccessoryDescription` exposes `AccessoryType`, `AssetId`, `Instance`,
  `IsLayered`, `Order`, `Position`, `Rotation`, `Scale` (`Puffiness` deprecated).
- `Enum.AccessoryType` is used mainly in `AccessoryBlob` and `Accessory.Type`.

## 8. Validation performed

See `README` §9 for the automated check; results:

- All four JSON files parse.
- No duplicate numeric ids within any enum.
- No duplicate names within any enum.
- `entryCount` matches the actual array length in every file.
- Every `AvatarAssetType` id exists in `AssetType`.
- Every `accessoryTypeId` mapping resolves to an existing `AccessoryType` entry,
  and every `mappedAvatarAssetTypeIds` target exists in `AvatarAssetType`.
- Compatibility draft covers all `AvatarAssetType` entries and uses only
  documented status values.
- The three enums remain separate files with distinct value spaces.

## 9. Known gaps / future work

- Verify `AnimatedImage`, `ComputeFunction`, `SpawnEffect` against Creator Hub
  once they appear in the published docs.
- Runtime-verify layered clothing, thin layered accessories (eyebrow/eyelash),
  makeup and dynamic heads against real avatar payloads.
- Consider generating these files from an API dump at build time (documentation
  generator) if the reference becomes part of a documented feature.
