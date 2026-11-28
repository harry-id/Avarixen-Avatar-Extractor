# Research fixtures

Rig blueprints captured from Roblox Studio (via the avatar inspector), used as
ground truth for the auto-rig and exporter work.

## roblox_generated/

One folder per body variant, each with `content.json` and `metadata.json`.
`content.json` holds: `bones`, `motors` (joint name, part0/part1, C0/C1),
`constraints`, `parts` (name, size, localCFrame), `attachments` (name, parent,
cframe) and `humanoid` (rigType, scales, hipHeight).

- Variants: `block`, `mesh_2012`, `mesh_2016`, `rthro`, `skinned`, for both
  `r6_*` and `r15_*`.
- They contain **no geometry** (no OBJ/MTL/textures) and **no asset ids**.
- The R6 variants are structurally identical (geometry-only differences).
- The **R15 fixtures captured no motors** (0 joints); their body-type
  differences live in part sizes and `humanoid.scales` (BodyTypeScale etc.).

Useful for: rig comparison, attachment names and their parent parts, and
body-type part sizes / scales.

## user_avatar/

Intentionally **not** committed: those fixtures are named after real players.