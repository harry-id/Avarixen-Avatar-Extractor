# Avarixen Avatar Extractor — Export Test Results

| | |
|---|---|
| **Avatar** | 0xHarry (userId `4437958744`) |
| **Targets** | Blender 3.6 · Prisma3D |

**Legend**

| Result | Meaning |
|---|---|
| `PASS` | Passed with no user action required. |
| `PASS*` | Passed, but needs a manual step or has a cosmetic quirk (see [Notes](#notes)). |

## Summary

| Mode | Format | App | Geometry | Transform | Textures | Compatibility | Rigging |
|---|---|---|---|---|---|---|---|
| Standard | OBJ | Blender 3.6 | PASS | PASS | PASS | PASS | — |
| Standard | OBJ | Prisma3D | PASS | PASS | PASS | PASS | — |
| Standard | GLB | Blender 3.6 | PASS | PASS | PASS | PASS | — |
| Standard | GLB | Prisma3D | PASS | PASS | PASS | PASS | — |
| Standard | GLTF | Blender 3.6 | PASS | PASS | PASS | PASS | — |
| Standard | GLTF | Prisma3D | PASS | PASS | PASS | PASS | — |
| Standard | FBX | Blender 3.6 | PASS | PASS | PASS | PASS* | — |
| Standard | FBX | Prisma3D | PASS | PASS | PASS | PASS | — |
| Separate assets | OBJ | Blender 3.6 | PASS | PASS | PASS | PASS | — |
| Separate assets | OBJ | Prisma3D | PASS | PASS | PASS* | PASS | — |
| Separate assets | GLB | Blender 3.6 | PASS | PASS | PASS | PASS | — |
| Separate assets | GLB | Prisma3D | PASS | PASS | PASS | PASS | — |
| Separate assets | GLTF | Blender 3.6 | PASS | PASS | PASS | PASS | — |
| Separate assets | GLTF | Prisma3D | PASS | PASS | PASS* | PASS | — |
| Separate assets | FBX | Blender 3.6 | PASS | PASS | PASS | PASS* | — |
| Separate assets | FBX | Prisma3D | PASS | PASS | PASS* | PASS | — |
| Rigged | GLB | Blender 3.6 | PASS | PASS | PASS | PASS | PASS |
| Rigged | GLB | Prisma3D | PASS | PASS | PASS | PASS | PASS |

## 1. Standard

Single file with embedded textures; body parts are separate objects.

### OBJ

| Check | Blender 3.6 | Prisma3D |
|---|---|---|
| Geometry | PASS | PASS |
| Transform | PASS | PASS |
| Textures | PASS | PASS |
| Compatibility | PASS | PASS |

```
Blender 3.6                          Prisma3D
[Scene Collection]                   . (root)
└── Collection (default)             └── avatar
      └── ... parts ...                    └── ... parts ...
```

### GLB

| Check | Blender 3.6 | Prisma3D |
|---|---|---|
| Geometry | PASS | PASS |
| Transform | PASS | PASS |
| Textures | PASS | PASS |
| Compatibility | PASS | PASS |

```
Blender 3.6                          Prisma3D
[Scene Collection]                   . (root)
└── 0xHarry                          └── avatar
      └── ... parts ...                    └── Scene
                                                 └── 0xHarry
                                                       └── ... parts ...
```

### GLTF

| Check | Blender 3.6 | Prisma3D |
|---|---|---|
| Geometry | PASS | PASS |
| Transform | PASS | PASS |
| Textures | PASS | PASS |
| Compatibility | PASS | PASS |

```
Blender 3.6                          Prisma3D
[Scene Collection]                   . (root)
└── 0xHarry                          └── avatar
      └── ... parts ...                    └── Scene
                                                 └── 0xHarry
                                                       └── ... parts ...
```

### FBX

| Check | Blender 3.6 | Prisma3D |
|---|---|---|
| Geometry | PASS | PASS |
| Transform | PASS | PASS |
| Textures | PASS | PASS |
| Compatibility | PASS* | PASS |

> **Blender:** removing the `0xHarry` group makes the character tip forward 90°.
> The group carries the FBX → Blender axis conversion. *(Cosmetic)*

```
Blender 3.6                          Prisma3D
[Scene Collection]                   . (root)
└── Collection (default)             └── avatar
      └── 0xHarry                          └── 0xHarry
            └── ... parts ...                    └── ... parts ...
```

## 2. Separate assets

Body parts as objects plus external assets in one ZIP.

### OBJ

| Check | Blender 3.6 | Prisma3D |
|---|---|---|
| Geometry | PASS | PASS |
| Transform | PASS | PASS |
| Textures | PASS | PASS* |
| Compatibility | PASS | PASS |

> **Prisma3D:** manual texture setup — no automatic texture load.

```
Blender 3.6                          Prisma3D
[Scene Collection]                   . (root)
└── Collection (default)             └── avatar
      └── ... parts ...                    └── ... parts ...
```

### GLB (embedded, not a ZIP)

| Check | Blender 3.6 | Prisma3D |
|---|---|---|
| Geometry | PASS | PASS |
| Transform | PASS | PASS |
| Textures | PASS | PASS |
| Compatibility | PASS | PASS |

```
Blender 3.6                          Prisma3D
[Scene Collection]                   . (root)
└── 0xHarry                          └── avatar
      └── ... parts ...                    └── Scene
                                                 └── 0xHarry
                                                       └── ... parts ...
```

### GLTF

| Check | Blender 3.6 | Prisma3D |
|---|---|---|
| Geometry | PASS | PASS |
| Transform | PASS | PASS |
| Textures | PASS | PASS* |
| Compatibility | PASS | PASS |

> **Prisma3D:** manual texture setup — no automatic texture load.

```
Blender 3.6                          Prisma3D
[Scene Collection]                   . (root)
└── 0xHarry                          └── avatar
      └── ... parts ...                    └── Scene
                                                 └── 0xHarry
                                                       └── ... parts ...
```

### FBX

| Check | Blender 3.6 | Prisma3D |
|---|---|---|
| Geometry | PASS | PASS |
| Transform | PASS | PASS |
| Textures | PASS | PASS* |
| Compatibility | PASS* | PASS |

> **Blender:** removing the `0xHarry` group makes the character tip forward 90°.
> The group carries the FBX → Blender axis conversion. *(Cosmetic)*
>
> **Prisma3D:** manual texture setup — no automatic texture load.

```
Blender 3.6                          Prisma3D
[Scene Collection]                   . (root)
└── Collection (default)             └── avatar
      └── 0xHarry                          └── 0xHarry
            └── ... parts ...                    └── ... parts ...
```

## 3. Rigged — GLB

R6 skeleton with skinned part objects.

| Check | Blender 3.6 | Prisma3D |
|---|---|---|
| Geometry | PASS | PASS |
| Transform | PASS | PASS |
| Textures | PASS | PASS |
| Compatibility | PASS | PASS |
| Rigging | PASS | PASS |

```
Blender 3.6                          Prisma3D
[Scene Collection]                   . (root)
└── 0xHarry                          └── avatar_rigged
      ├── skin                               └── Scene
      │     └── HumanoidRootPart                   └── 0xHarry
      │           └── ...                                ├── HumanoidRootPart
      ├── pose                                           │     └── ...
      └── ... parts ...                                  └── ... parts ...
```

## Notes

1. Blender cannot store or import named Collections from OBJ, GLB, GLTF, or FBX.
   GLB/GLTF/FBX use a parent empty (`0xHarry`); OBJ parts are flat objects.
   Use **M → New Collection** in Blender if folder semantics are required.
2. Prisma3D does not always auto-load external textures for OBJ/GLTF/FBX;
   assigning textures manually works.
3. FBX in Blender: keep the `0xHarry` parent. It holds the axis conversion;
   deleting it tips the parts forward by 90°.
4. The separate-assets GLB in the test pack is still an embedded `.glb`.
   The API returns a ZIP containing `.gltf` + `.bin` + textures when GLB is
   requested with **Separate assets** enabled.
