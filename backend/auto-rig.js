"use strict";

const fs = require("fs");
const path = require("path");
const { Document, Accessor, Material } = require("@gltf-transform/core");
const { parsePositiveNumber } = require("./config");

const DEFAULT_MAX_OBJ_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_OBJ_VERTICES = 1_500_000;
const DEFAULT_MAX_OBJ_FACES = 1_000_000;

function readObjLimits(overrides = {}) {
    return {
        maxBytes: overrides.maxBytes !== undefined
            ? overrides.maxBytes
            : parsePositiveNumber(process.env.MAX_OBJ_BYTES, DEFAULT_MAX_OBJ_BYTES),
        maxVertices: overrides.maxVertices !== undefined
            ? overrides.maxVertices
            : parsePositiveNumber(process.env.MAX_OBJ_VERTICES, DEFAULT_MAX_OBJ_VERTICES),
        maxFaces: overrides.maxFaces !== undefined
            ? overrides.maxFaces
            : parsePositiveNumber(process.env.MAX_OBJ_FACES, DEFAULT_MAX_OBJ_FACES)
    };
}

function objLimitError(kind, limit) {
    const error = new Error(`OBJ exceeds the configured ${kind} limit (${limit})`);
    error.name = "ObjLimitError";
    error.code = "EOBJTOOLARGE";
    error.status = 413;
    error.limitKind = kind;
    return error;
}

function assertObjTextLimits(text, limits = readObjLimits()) {
    if (Buffer.byteLength(text) > limits.maxBytes) {
        throw objLimitError("byte", limits.maxBytes);
    }

    let vertices = 0;
    let faces = 0;

    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trimStart();
        const tag = trimmed.split(/\s+/, 1)[0];

        if (tag === "v") {
            vertices += 1;
            if (vertices > limits.maxVertices) {
                throw objLimitError("vertex", limits.maxVertices);
            }
        } else if (tag === "f") {
            faces += 1;
            if (faces > limits.maxFaces) {
                throw objLimitError("face", limits.maxFaces);
            }
        }
    }
}


function parseMtl(mtlPath) {
    const materials = Object.create(null);
    if (!fs.existsSync(mtlPath)) {
        return materials;
    }
    let current = null;
    const lines = fs.readFileSync(mtlPath, "utf8").split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const parts = line.split(/\s+/);
        const tag = parts[0];
        if (tag === "newmtl") {
            current = parts.slice(1).join(" ") || "default";
            materials[current] = {
                name: current,
                Kd: [0.8, 0.8, 0.8],
                map_Kd: null,
                opacity: 1
            };
        } else if (current && tag === "Kd") {
            const kd = [+parts[1], +parts[2], +parts[3]];
            if (kd.every(Number.isFinite)) {
                materials[current].Kd = kd;
            }
        } else if (current && (tag === "map_Kd" || tag === "map_kd")) {
            materials[current].map_Kd = parts.slice(1).join(" ") || null;
        } else if (current && (tag === "d" || tag === "Tr")) {
            const value = Number(parts[parts.length - 1]);
            if (Number.isFinite(value)) {
                const clamped = Math.max(0, Math.min(1, value));
                materials[current].opacity = tag === "Tr" ? 1 - clamped : clamped;
            }
        }
    }
    return materials;
}

// Resolve a texture path from the MTL while keeping it inside the asset dir.
function resolveAssetTexture(assetDir, filename) {
    if (!filename) {
        return null;
    }

    const resolved = path.resolve(assetDir, filename);
    const root = path.resolve(assetDir);

    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return null;
    }

    return resolved;
}

function parseObj(objPath, limits = readObjLimits()) {
    const stat = fs.statSync(objPath);
    if (stat.size > limits.maxBytes) {
        throw objLimitError("byte", limits.maxBytes);
    }

    return parseObjString(fs.readFileSync(objPath, "utf8"), limits);
}

function parseObjString(text, limits = readObjLimits()) {
    if (Buffer.byteLength(text) > limits.maxBytes) {
        throw objLimitError("byte", limits.maxBytes);
    }

    const positions = [];
    const normals = [];
    const uvs = [];
    const vertexColors = [];
    const faces = [];
    let vertexCount = 0;
    let faceCount = 0;
    let currentMaterial = "default";
    let currentGroup = null;
    let currentObject = null;

    const finite = (value, label) => {
        const number = Number(value);
        if (!Number.isFinite(number)) {
            throw new Error(`OBJ ${label} contains a non-numeric value`);
        }
        return number;
    };

    const resolveIndex = (raw, count) => {
        if (raw === undefined || raw === "") {
            return -1;
        }
        const index = Number(raw);
        if (!Number.isInteger(index) || index === 0) {
            return -1;
        }
        return index > 0 ? index - 1 : count + index;
    };

    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const parts = line.split(/\s+/);
        const tag = parts[0];

        if (tag === "v") {
            const x = finite(parts[1], "vertex");
            const y = finite(parts[2], "vertex");
            const z = finite(parts[3], "vertex");
            positions.push(x, y, z);
            vertexCount += 1;
            if (vertexCount > limits.maxVertices) {
                throw objLimitError("vertex", limits.maxVertices);
            }
            if (parts.length >= 7) {
                vertexColors.push(
                    finite(parts[4], "vertex color"),
                    finite(parts[5], "vertex color"),
                    finite(parts[6], "vertex color"),
                    parts.length >= 8 ? finite(parts[7], "vertex color") : 1.0
                );
            } else {
                vertexColors.push(1, 1, 1, 1);
            }
        } else if (tag === "vn") {
            normals.push(
                finite(parts[1], "normal"),
                finite(parts[2], "normal"),
                finite(parts[3], "normal")
            );
        } else if (tag === "vt") {
            uvs.push(
                finite(parts[1], "UV"),
                parts[2] === undefined ? 0 : finite(parts[2], "UV")
            );
        } else if (tag === "usemtl") {
            currentMaterial = parts.slice(1).join(" ") || "default";
        } else if (tag === "g") {
            currentGroup = parts.slice(1).join(" ") || null;
        } else if (tag === "o") {
            currentObject = parts.slice(1).join(" ") || null;
            currentGroup = null;
        } else if (tag === "f") {
            if (parts.length < 4) {
                throw new Error("OBJ face needs at least three vertices");
            }

            const vertCount = positions.length / 3;
            const uvCount = uvs.length / 2;
            const normalCount = normals.length / 3;
            const vertIdx = [];
            const normIdx = [];
            const uvIdx = [];

            for (let i = 1; i < parts.length; i++) {
                const [v, t, n] = parts[i].split("/");
                const vertex = resolveIndex(v, vertCount);
                const uv = resolveIndex(t, uvCount);
                const normal = resolveIndex(n, normalCount);

                if (vertex < 0 || vertex >= vertCount) {
                    throw new Error("OBJ face references an invalid vertex index");
                }
                if (t !== undefined && t !== "" && (uv < 0 || uv >= uvCount)) {
                    throw new Error("OBJ face references an invalid UV index");
                }
                if (n !== undefined && n !== "" && (normal < 0 || normal >= normalCount)) {
                    throw new Error("OBJ face references an invalid normal index");
                }

                vertIdx.push(vertex);
                uvIdx.push(uv);
                normIdx.push(normal);
            }

            const group = currentGroup || currentObject || "Avatar";
            faceCount += 1;
            if (faceCount > limits.maxFaces) {
                throw objLimitError("face", limits.maxFaces);
            }

            for (let i = 1; i < vertIdx.length - 1; i++) {
                faces.push({
                    verts: [vertIdx[0], vertIdx[i], vertIdx[i + 1]],
                    norms: [normIdx[0], normIdx[i], normIdx[i + 1]],
                    uvs: [uvIdx[0], uvIdx[i], uvIdx[i + 1]],
                    material: currentMaterial,
                    group
                });
            }
        }
    }

    return { positions, normals, uvs, vertexColors, groups: rebuildGroups(faces), faces };
}

function rebuildGroups(faces) {
    const map = new Map();

    faces.forEach((face, index) => {
        const groupName = face.group || "Avatar";
        let entry = map.get(groupName);

        if (!entry) {
            entry = {
                name: groupName,
                faceIndices: [],
                vertices: new Set()
            };
            map.set(groupName, entry);
        }

        entry.faceIndices.push(index);
        for (const v of face.verts) {
            entry.vertices.add(v);
        }
    });

    return Array.from(map.values()).map((entry) => ({
        name: entry.name,
        vertexIndices: Array.from(entry.vertices).sort((a, b) => a - b),
        faceIndices: entry.faceIndices,
        faceCount: entry.faceIndices.length,
        material: faces[entry.faceIndices[0]]?.material || "default"
    }));
}

/**
 * Linear midpoint subdivision. Each level turns every triangle into four and
 * preserves UVs, normals, vertex colors, materials, and OBJ groups.
 * Levels are capped so an avatar cannot explode past ~3.5M faces.
 */
function subdivideParsed(parsed, levels, shouldSubdivide = null) {
    let safeLevels = Math.max(0, Math.min(4, Math.floor(levels || 0)));

    while (
        safeLevels > 0 &&
        parsed.faces.length * Math.pow(4, safeLevels) > 3_500_000
    ) {
        safeLevels -= 1;
    }

    for (let level = 0; level < safeLevels; level++) {
        const nextFaces = [];
        const midpointCache = new Map();

        const midpoint = (c1, c2) => {
            // Adjacent faces share an edge. Cache the midpoint (including its
            // attribute indices) so the edge is not split into duplicate
            // vertices. The key is order-independent and keeps UV/normal seams
            // separate when the attributes differ.
            const key = [
                Math.min(c1.p, c2.p), Math.max(c1.p, c2.p),
                Math.min(c1.n, c2.n), Math.max(c1.n, c2.n),
                Math.min(c1.t, c2.t), Math.max(c1.t, c2.t)
            ].join("|");

            if (midpointCache.has(key)) {
                return midpointCache.get(key);
            }

            const p1 = [
                parsed.positions[c1.p * 3],
                parsed.positions[c1.p * 3 + 1],
                parsed.positions[c1.p * 3 + 2]
            ];
            const p2 = [
                parsed.positions[c2.p * 3],
                parsed.positions[c2.p * 3 + 1],
                parsed.positions[c2.p * 3 + 2]
            ];

            const p = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];
            const pIdx = parsed.positions.length / 3;
            parsed.positions.push(...p);

            let nIdx = -1;
            if (c1.n >= 0 && c2.n >= 0) {
                const n1 = [
                    parsed.normals[c1.n * 3],
                    parsed.normals[c1.n * 3 + 1],
                    parsed.normals[c1.n * 3 + 2]
                ];
                const n2 = [
                    parsed.normals[c2.n * 3],
                    parsed.normals[c2.n * 3 + 1],
                    parsed.normals[c2.n * 3 + 2]
                ];
                let n = [
                    (n1[0] + n2[0]) / 2,
                    (n1[1] + n2[1]) / 2,
                    (n1[2] + n2[2]) / 2
                ];
                const length = Math.hypot(n[0], n[1], n[2]);
                n = length > 0
                    ? [n[0] / length, n[1] / length, n[2] / length]
                    : [0, 1, 0];
                nIdx = parsed.normals.length / 3;
                parsed.normals.push(...n);
            }

            let tIdx = -1;
            if (c1.t >= 0 && c2.t >= 0) {
                const t = [
                    (parsed.uvs[c1.t * 2] + parsed.uvs[c2.t * 2]) / 2,
                    (parsed.uvs[c1.t * 2 + 1] + parsed.uvs[c2.t * 2 + 1]) / 2
                ];
                tIdx = parsed.uvs.length / 2;
                parsed.uvs.push(...t);
            }

            const c1Colors = [
                parsed.vertexColors[c1.p * 4],
                parsed.vertexColors[c1.p * 4 + 1],
                parsed.vertexColors[c1.p * 4 + 2],
                parsed.vertexColors[c1.p * 4 + 3]
            ];
            const c2Colors = [
                parsed.vertexColors[c2.p * 4],
                parsed.vertexColors[c2.p * 4 + 1],
                parsed.vertexColors[c2.p * 4 + 2],
                parsed.vertexColors[c2.p * 4 + 3]
            ];
            parsed.vertexColors.push(
                (c1Colors[0] + c2Colors[0]) / 2,
                (c1Colors[1] + c2Colors[1]) / 2,
                (c1Colors[2] + c2Colors[2]) / 2,
                (c1Colors[3] + c2Colors[3]) / 2
            );

            const result = { p: pIdx, n: nIdx, t: tIdx };
            midpointCache.set(key, result);
            return result;
        };

        for (const face of parsed.faces) {
            if (
                face.verts.length !== 3 ||
                (shouldSubdivide && !shouldSubdivide(face))
            ) {
                nextFaces.push(face);
                continue;
            }

            const corner = (i) => ({
                p: face.verts[i],
                n: face.norms[i] ?? -1,
                t: face.uvs[i] ?? -1
            });

            const c0 = corner(0);
            const c1 = corner(1);
            const c2 = corner(2);
            const a = midpoint(c0, c1);
            const b = midpoint(c1, c2);
            const c = midpoint(c2, c0);

            const tri = (p1, p2, p3) => ({
                verts: [p1.p, p2.p, p3.p],
                norms: [p1.n, p2.n, p3.n],
                uvs: [p1.t, p2.t, p3.t],
                material: face.material,
                group: face.group
            });

            nextFaces.push(
                tri(c0, a, c),
                tri(c1, b, a),
                tri(c2, c, b),
                tri(a, b, c)
            );
        }

        parsed.faces = nextFaces;
        parsed.groups = rebuildGroups(parsed.faces);
    }

    return parsed;
}

function computeBox(vertexIndices, positions) {
    let xmin = Infinity, xmax = -Infinity;
    let ymin = Infinity, ymax = -Infinity;
    let zmin = Infinity, zmax = -Infinity;
    for (const vi of vertexIndices) {
        const x = positions[vi * 3];
        const y = positions[vi * 3 + 1];
        const z = positions[vi * 3 + 2];
        if (x < xmin) xmin = x;
        if (x > xmax) xmax = x;
        if (y < ymin) ymin = y;
        if (y > ymax) ymax = y;
        if (z < zmin) zmin = z;
        if (z > zmax) zmax = z;
    }
    return {
        xmin, xmax, ymin, ymax, zmin, zmax,
        cx: (xmin + xmax) / 2,
        cy: (ymin + ymax) / 2,
        cz: (zmin + zmax) / 2,
        sx: xmax - xmin,
        sy: ymax - ymin,
        sz: zmax - zmin,
        n: vertexIndices.length
    };
}

function detectRigType(playerCount) {
    if (playerCount === 6) return "R6";
    // Partial/custom R15 avatars (7–15 parts) still use the R15 skeleton.
    if (playerCount > 6 && playerCount <= 15) return "R15";
    return null;
}

const R6_PART_NAMES = ["Head", "Torso", "Left Arm", "Right Arm", "Left Leg", "Right Leg"];

const R15_PART_NAMES = [
    "Head",
    "UpperTorso",
    "LowerTorso",
    "LeftUpperArm",
    "RightUpperArm",
    "LeftLowerArm",
    "RightLowerArm",
    "LeftHand",
    "RightHand",
    "LeftUpperLeg",
    "RightUpperLeg",
    "LeftLowerLeg",
    "RightLowerLeg",
    "LeftFoot",
    "RightFoot"
];

function normalizePartName(name) {
    return String(name).replace(/\s+/g, "").toLowerCase();
}

// Exported avatars are renamed from PlayerN to body-part names, so conversions
// must still detect the rig and map bones when the groups are already named.
function detectNamedRigType(groups) {
    const names = new Set(groups.map((group) => normalizePartName(group.name)));
    const has = (name) => names.has(normalizePartName(name));

    if (R6_PART_NAMES.every(has)) {
        return "R6";
    }

    if (R15_PART_NAMES.every(has)) {
        return "R15";
    }

    // Partial/custom R15 avatars (a limb segment missing) still use the R15
    // skeleton. Any R15-only part name (UpperTorso, UpperArm, ...) plus a
    // majority of the R15 parts is enough to classify it as R15 instead of
    // leaving it unrigged.
    const r15Only = R15_PART_NAMES.filter((name) => !R6_PART_NAMES.includes(name));
    const hasR15Only = r15Only.some(has);
    const r15Matches = R15_PART_NAMES.filter(has).length;

    if (hasR15Only && r15Matches >= 7) {
        return "R15";
    }

    return null;
}

/**
 * Resolve the rig type from the available evidence.
 *
 * Evidence, strongest first:
 *   1. Renamed body-part groups (Head, UpperTorso, ...) — unambiguous.
 *   2. PlayerN group count (6 = R6, 7..15 = R15).
 *   3. The Roblox `playerAvatarType` hint ("R6"/"R15"), used only to
 *      disambiguate a borderline PlayerN count (e.g. 6 groups that are
 *      actually a heavily-merged R15).
 *
 * Returns { rigType, source } where source is "named" | "players" | "hint" |
 * null. `rigType` is null when nothing can be determined.
 */
function resolveRigType(groups, playerCount, hint) {
    const named = detectNamedRigType(groups);
    if (named) {
        return { rigType: named, source: "named" };
    }

    const byCount = detectRigType(playerCount);
    if (byCount && playerCount !== 6) {
        return { rigType: byCount, source: "players" };
    }

    // A count of 6 is ambiguous: usually R6, but a heavily-merged R15 can also
    // expose six groups. Defer to the Roblox hint when we have one.
    if (playerCount === 6) {
        if (hint === "R6" || hint === "R15") {
            return { rigType: hint, source: "hint" };
        }
        return { rigType: "R6", source: "players" };
    }

    // No usable PlayerN count, but Roblox still knows the type.
    if (hint === "R6" || hint === "R15") {
        return { rigType: hint, source: "hint" };
    }

    return { rigType: null, source: null };
}

// Full list of rig parts that make an avatar "complete" for each rig type.
const RIG_EXPECTED_PARTS = {
    R6: R6_PART_NAMES,
    R15: R15_PART_NAMES
};

/**
 * Build a compatibility report from a part mapping.
 *
 * `status` is one of:
 *   - "compatible"   — every expected part was mapped.
 *   - "partial"      — rig detected but one or more parts are missing.
 *   - "incompatible" — no rig could be detected at all.
 */
function computeCompatibility(rigType, partMapping) {
    if (!rigType) {
        return {
            status: "incompatible",
            expected: 0,
            matched: 0,
            missing: [],
            complete: false
        };
    }

    const expected = RIG_EXPECTED_PARTS[rigType] || [];
    const matchedParts = expected.filter((part) => partMapping[part]);
    const missing = expected.filter((part) => !partMapping[part]);
    const complete = missing.length === 0;

    return {
        status: complete ? "compatible" : "partial",
        expected: expected.length,
        matched: matchedParts.length,
        missing,
        complete
    };
}

// Map each rig part (Head, Left Arm, ...) to the actual group name in the OBJ,
// which may be written as LeftArm to avoid OBJ's whitespace-separated groups.
// Parts that are absent from the OBJ are simply skipped so partial/custom
// avatars can still produce a valid (partial) skeleton.
function mappingFromPartNames(rigType, groups) {
    const partNames = rigType === "R6" ? R6_PART_NAMES : R15_PART_NAMES;
    const groupByNormalized = new Map(
        groups.map((group) => [normalizePartName(group.name), group.name])
    );
    const mapping = {};

    for (const name of partNames) {
        const groupName = groupByNormalized.get(normalizePartName(name));
        if (groupName) {
            mapping[name] = groupName;
        }
    }

    return mapping;
}

function nearestMappedPart(box, boxes, mapping) {
    const point = { x: box.cx, y: box.cy, z: box.cz };
    let bestPart = null;
    let bestDistance = Infinity;

    for (const [part, groupName] of Object.entries(mapping)) {
        const reference = boxes[groupName];
        if (!reference || !Number.isFinite(reference.cx)) {
            continue;
        }

        const distance = distanceToBox(point, reference);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestPart = part;
        }
    }

    return bestPart;
}

function partReferenceNames(part, rigType) {
    const side = part.startsWith("Left")
        ? "Left"
        : part.startsWith("Right")
            ? "Right"
            : null;

    if (rigType === "R6") {
        if (part === "Torso") {
            return ["Head", "Left Arm", "Right Arm", "Left Leg", "Right Leg"];
        }
        return part === "Head" ? ["Torso"] : ["Torso"];
    }

    if (part === "Head") return ["UpperTorso", "LowerTorso"];
    if (part === "UpperTorso") return ["LowerTorso", "Head"];
    if (part === "LowerTorso") return ["UpperTorso"];
    if (!side) return [];

    if (part.endsWith("UpperArm")) return ["UpperTorso", `${side}LowerArm`];
    if (part.endsWith("LowerArm")) return [`${side}UpperArm`, `${side}Hand`];
    if (part.endsWith("Hand")) return [`${side}LowerArm`, `${side}UpperArm`];
    if (part.endsWith("UpperLeg")) return ["LowerTorso", `${side}LowerLeg`];
    if (part.endsWith("LowerLeg")) return [`${side}UpperLeg`, `${side}Foot`];
    if (part.endsWith("Foot")) return [`${side}LowerLeg`, `${side}UpperLeg`];

    return [];
}

function bodyCenterX(mapping, boxes) {
    const names = ["UpperTorso", "LowerTorso", "Torso"];
    let total = 0;
    let count = 0;

    for (const name of names) {
        const groupName = mapping[name];
        const box = groupName ? boxes[groupName] : null;
        if (box && Number.isFinite(box.cx)) {
            total += box.cx;
            count += 1;
        }
    }

    return count ? total / count : 0;
}

function partSideMatches(part, box, mapping, boxes) {
    if (!part.startsWith("Left") && !part.startsWith("Right")) {
        return true;
    }

    const centerX = bodyCenterX(mapping, boxes);
    return part.startsWith("Left") ? box.cx <= centerX : box.cx >= centerX;
}

// Mixed avatars can contain both named body groups and leftover PlayerN groups.
// Keep the named mapping, then use the leftovers only for missing parts when a
// nearby mapped group makes the assignment unambiguous.
function resolvePartMapping(groups, boxes, rigType) {
    const playerGroups = groups.filter((group) => /^Player\d+$/i.test(group.name));
    const named = mappingFromPartNames(rigType, groups);

    if (!playerGroups.length) {
        return { partMapping: named, extraGroupParts: {} };
    }

    if (!Object.keys(named).length) {
        return {
            partMapping: matchBodyParts(playerGroups, boxes, { rigType }),
            extraGroupParts: {}
        };
    }

    const expected = rigType === "R6" ? R6_PART_NAMES : R15_PART_NAMES;
    const mapping = { ...named };
    const used = new Set(Object.values(mapping));
    const leftovers = playerGroups.filter((group) => !used.has(group.name));

    for (const group of leftovers) {
        const box = boxes[group.name];
        if (!box || !Number.isFinite(box.cx)) {
            continue;
        }

        const nearest = nearestMappedPart(box, boxes, mapping);
        if (!nearest) {
            continue;
        }

        const candidates = expected.filter((part) =>
            !mapping[part] &&
            partReferenceNames(part, rigType).includes(nearest) &&
            partSideMatches(part, box, mapping, boxes)
        );

        if (candidates.length === 1) {
            mapping[candidates[0]] = group.name;
        }
    }

    const finalUsed = new Set(Object.values(mapping));
    const extraGroupParts = {};

    for (const group of leftovers) {
        if (finalUsed.has(group.name)) {
            continue;
        }

        const box = boxes[group.name];
        if (!box || !Number.isFinite(box.cx)) {
            continue;
        }

        const nearest = nearestMappedPart(box, boxes, mapping);
        if (nearest) {
            extraGroupParts[group.name] = nearest;
        }
    }

    return { partMapping: mapping, extraGroupParts };
}

function matchBodyParts(playerGroups, boxes, options = {}) {
    // Match Player groups to body parts by POSITION, never by group number.
    // Works for full R6/R15 rigs and for partial/custom avatars (e.g. an R15
    // with a missing limb segment).
    const parts = {};
    const remaining = [...playerGroups];

    if (!remaining.length) {
        return parts;
    }

    const byYDesc = (a, b) => boxes[b.name].cy - boxes[a.name].cy;

    // Head = highest group.
    const headGroup = remaining.sort(byYDesc).shift();
    parts.Head = headGroup.name;
    const headBox = boxes[headGroup.name];

    // R6 has exactly 6 groups; anything larger is treated as an R15-style rig
    // even when a part is missing. An explicit rigType (from the Roblox hint)
    // overrides the count so a merged R15 with six groups still maps as R15.
    const isR15 = options.rigType
        ? options.rigType === "R15"
        : playerGroups.length > 6;

    // Torso: centered groups in the upper half. Torso parts are the widest
    // centered groups, which keeps A-pose arms (hanging close to the body)
    // from being mistaken for the torso.
    const upper = remaining.filter(g => boxes[g.name].cy > headBox.cy * 0.45);
    const centered = upper.filter(g => Math.abs(boxes[g.name].cx) < 0.7);
    const hasWidths = centered.length > 0 &&
        centered.every(g => Number.isFinite(boxes[g.name].sx));

    const torsoCount = isR15 ? 2 : 1;
    let torsoCandidates;
    if (hasWidths) {
        torsoCandidates = [...centered]
            .sort((a, b) => boxes[b.name].sx - boxes[a.name].sx)
            .slice(0, torsoCount)
            .sort(byYDesc);
    } else {
        torsoCandidates = [...centered].sort(byYDesc).slice(0, torsoCount);
    }

    const torsoNames = [];
    for (const g of torsoCandidates) {
        const key = isR15
            ? (torsoNames.length === 0 ? "UpperTorso" : "LowerTorso")
            : "Torso";
        parts[key] = g.name;
        torsoNames.push(g.name);
    }

    const torsoSet = new Set(torsoNames);
    const limbs = remaining.filter(g => !torsoSet.has(g.name));

    // Arms sit outside the torso width; legs stay near the center line. When
    // the torso size is known, derive the threshold from it so A-pose arms
    // hanging close to the body are still recognized.
    const torsoBoxes = torsoNames.map(n => boxes[n]).filter(Boolean);
    const hasTorsoSizes = torsoBoxes.length > 0 &&
        torsoBoxes.every(b => Number.isFinite(b.sx));
    const torsoHalf = hasTorsoSizes
        ? Math.max(...torsoBoxes.map(b => b.sx / 2))
        : 0.7;
    const armThreshold = hasTorsoSizes
        ? Math.max(torsoHalf * 1.05, 0.3)
        : 1.0;

    const armCandidates = limbs.filter(g => Math.abs(boxes[g.name].cx) > armThreshold);
    const legCandidates = limbs.filter(g => Math.abs(boxes[g.name].cx) <= armThreshold);

    const assignChain = (candidates, segs, nameFor) => {
        const left = candidates
            .filter(g => boxes[g.name].cx < 0)
            .sort(byYDesc);
        const right = candidates
            .filter(g => boxes[g.name].cx > 0)
            .sort(byYDesc);

        const assignSide = (sideParts, otherParts, prefix) => {
            if (!isR15) {
                if (sideParts[0]) parts[nameFor(prefix, segs[0])] = sideParts[0].name;
                return;
            }

            const assignPositional = () => {
                segs.forEach((seg, i) => {
                    if (sideParts[i]) parts[nameFor(prefix, seg)] = sideParts[i].name;
                });
            };

            if (!otherParts.length || sideParts.length >= segs.length) {
                assignPositional();
                return;
            }

            // The opposite side has more segments (e.g. a missing forearm);
            // match each part to the nearest unused reference segment by height.
            const used = new Set();
            for (const g of sideParts) {
                let best = -1;
                let bestD = Infinity;
                otherParts.forEach((ref, i) => {
                    if (used.has(i)) return;
                    const d = Math.abs(boxes[ref.name].cy - boxes[g.name].cy);
                    if (d < bestD) {
                        bestD = d;
                        best = i;
                    }
                });
                if (best >= 0) {
                    used.add(best);
                    parts[nameFor(prefix, segs[best])] = g.name;
                }
            }
        };

        assignSide(left, right, "Left");
        assignSide(right, left, "Right");
    };

    assignChain(
        armCandidates,
        isR15 ? ["UpperArm", "LowerArm", "Hand"] : ["Arm"],
        (prefix, seg) => (isR15 ? prefix + seg : `${prefix} ${seg}`)
    );
    assignChain(
        legCandidates,
        isR15 ? ["UpperLeg", "LowerLeg", "Foot"] : ["Leg"],
        (prefix, seg) => (isR15 ? prefix + seg : `${prefix} ${seg}`)
    );

    return parts;
}

function computeRecenter(boxes, partMapping) {
    const allX = [];
    const allZ = [];
    let feetY = Infinity;

    for (const gname of Object.values(partMapping)) {
        const b = boxes[gname];
        allX.push(b.cx);
        allZ.push(b.cz);
        if (b.ymin < feetY) feetY = b.ymin;
    }

    const offsetX = allX.length ? allX.reduce((a, b) => a + b, 0) / allX.length : 0;
    const offsetY = feetY;
    const offsetZ = allZ.length ? allZ.reduce((a, b) => a + b, 0) / allZ.length : 0;

    return { offsetX, offsetY, offsetZ };
}

function computeJoints(partMapping, boxes, offsetX, offsetY, offsetZ, rigType, moreJoints = false) {
    const J = {};
    const get = (name) => boxes[partMapping[name]];
    const sub = (v) => [v[0] - offsetX, v[1] - offsetY, v[2] - offsetZ];
    const center = (b) => [b.cx, b.cy, b.cz];
    const topCenter = (b) => [b.cx, b.ymax, b.cz];
    const bottomCenter = (b) => [b.cx, b.ymin, b.cz];
    const leftCenter = (b) => [b.xmin, b.cy, b.cz];
    const rightCenter = (b) => [b.xmax, b.cy, b.cz];

    const facingFace = (parentBox, childBox) => {
        const dx = Math.abs(childBox.cx - parentBox.cx);
        const dy = Math.abs(childBox.cy - parentBox.cy);
        if (dy > dx) {
            return childBox.cy < parentBox.cy ? 'bottom' : 'top';
        } else {
            return childBox.cx < parentBox.cx ? 'left' : 'right';
        }
    };

    const facePoint = (box, face) => {
        switch (face) {
            case 'top': return topCenter(box);
            case 'bottom': return bottomCenter(box);
            case 'left': return leftCenter(box);
            case 'right': return rightCenter(box);
        }
    };
    const upperTorsoBox = boxes[partMapping.UpperTorso];
    const lowerTorsoBox = boxes[partMapping.LowerTorso];
    const r6TorsoBox = boxes[partMapping.Torso];
    const torsoBox = upperTorsoBox || lowerTorsoBox || r6TorsoBox;
    const headBox = boxes[partMapping.Head];
    const rootX = torsoBox ? torsoBox.cx : 0;
    const rootZ = torsoBox ? torsoBox.cz : 0;
    const rootY = lowerTorsoBox ? lowerTorsoBox.ymin : (r6TorsoBox ? r6TorsoBox.ymin : (headBox ? headBox.ymin : 0));
    const rootName = rigType === "R6" ? "HumanoidRootPart" : "Root";
    J[rootName] = sub([rootX, rootY, rootZ]);
    if (rigType === "R6") {
        if (partMapping.Torso) J.Torso = sub(center(get("Torso")));

        if (moreJoints && r6TorsoBox) {
            // Waist pivot above the hip (not coincident with the root) so the
            // upper body can bend without creating a zero-length root bone.
            J.Waist = sub([
                r6TorsoBox.cx,
                r6TorsoBox.ymin + r6TorsoBox.sy * 0.3,
                r6TorsoBox.cz
            ]);
        }
    } else {
        if (partMapping.UpperTorso) J.UpperTorso = sub(center(get("UpperTorso")));
        if (partMapping.LowerTorso) J.LowerTorso = sub(center(get("LowerTorso")));
    }
    if (partMapping.Head) {
        J.Head = sub(center(get("Head")));
        const torsoForNeck = upperTorsoBox || r6TorsoBox || lowerTorsoBox;
        if (torsoForNeck) {
            J.Neck = sub([headBox.cx, headBox.ymin, headBox.cz]);
        }
    }
    const limbChains = [
        ["LeftUpperArm", "LeftLowerArm", "LeftHand", "Left Arm"],
        ["RightUpperArm", "RightLowerArm", "RightHand", "Right Arm"],
        ["LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "Left Leg"],
        ["RightUpperLeg", "RightLowerLeg", "RightFoot", "Right Leg"]
    ];

    for (const [upperName, lowerName, endName, r6Name] of limbChains) {
        const upperBox = partMapping[upperName] ? get(upperName) : null;
        const lowerBox = partMapping[lowerName] ? get(lowerName) : null;
        const endBox = partMapping[endName] ? get(endName) : null;
        const r6Box = partMapping[r6Name] ? get(r6Name) : null;

        if (rigType === "R6" && r6Box && !upperBox) {
            const isArm = r6Box.cy > r6TorsoBox.cy - 0.5;
            const attachX = r6Box.cx;
            const attachY = isArm ? r6TorsoBox.ymax : r6TorsoBox.ymin;
            const side = r6Name.split(" ")[0];

            J[r6Name] = sub([attachX, attachY, r6TorsoBox.cz]);

            if (isArm) {
                // Hands at the bottom of each arm so accessories can attach.
                J[`${side} Hand`] = sub(bottomCenter(r6Box));

                if (moreJoints) {
                    // Elbow at the limb midpoint for a natural bend.
                    J[`${side} LowerArm`] = sub([
                        r6Box.cx,
                        r6Box.cy,
                        r6Box.cz
                    ]);
                }
            } else {
                if (moreJoints) {
                    // Knee at the limb midpoint for a natural bend.
                    J[`${side} LowerLeg`] = sub([
                        r6Box.cx,
                        r6Box.cy,
                        r6Box.cz
                    ]);
                }
                // Foot at the bottom of each leg. Besides the ankle joint, this
                // gives the leg bone a child so its tail points down instead of
                // up into the torso.
                J[`${side} Foot`] = sub(bottomCenter(r6Box));
            }
        } else if (upperBox || lowerBox || endBox) {
            if (upperBox) {
                const torsoRef = upperTorsoBox || lowerTorsoBox;
                const isArm = torsoRef ? upperBox.cy > torsoRef.cy - 0.5 : true;
                const attachBox = isArm
                    ? (upperTorsoBox || torsoRef)
                    : (lowerTorsoBox || torsoRef);

                if (attachBox) {
                    const side = upperBox.cx < 0 ? 'left' : 'right';
                    // Arms attach at the shoulder (torso side); legs hang from
                    // the center of the upper leg so the leg bone points
                    // straight down instead of angling in from the hip edge.
                    const attachX = isArm
                        ? (side === 'left' ? attachBox.xmin : attachBox.xmax)
                        : upperBox.cx;
                    const attachY = isArm ? attachBox.ymax : upperBox.ymax;
                    const attachZ = isArm ? attachBox.cz : upperBox.cz;
                    J[upperName] = sub([attachX, attachY, attachZ]);
                }
            }
            if (upperBox && lowerBox) {
                const f = facingFace(upperBox, lowerBox);
                J[lowerName] = sub(facePoint(upperBox, f));
            }
            if (lowerBox && endBox) {
                const f = facingFace(lowerBox, endBox);
                J[endName] = sub(facePoint(lowerBox, f));
            }
            if (upperBox && !lowerBox && endBox) {
                // A missing middle segment (e.g. a merged/missing forearm):
                // bridge it so the chain still has three joints.
                const f = facingFace(upperBox, endBox);
                const opposite = {
                    top: "bottom",
                    bottom: "top",
                    left: "right",
                    right: "left"
                }[f];
                J[lowerName] = sub(facePoint(upperBox, f));
                J[endName] = sub(facePoint(endBox, opposite));
            }
        }
    }

    return J;
}

function distanceToBox(point, box) {
    const dx = Math.max(box.xmin - point.x, 0, point.x - box.xmax);
    const dy = Math.max(box.ymin - point.y, 0, point.y - box.ymax);
    const dz = Math.max(box.zmin - point.z, 0, point.z - box.zmax);

    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function hipsPart(rigType) {
    return rigType === "R15" ? "LowerTorso" : "Torso";
}

// R6 has no hand parts, so expose synthetic hand boxes at the bottom of each
// arm for accessory assignment.
function addR6HandBoxes(playerBoxes) {
    for (const side of ["Left", "Right"]) {
        const arm = playerBoxes[side + " Arm"];

        if (!arm) {
            continue;
        }

        const height = Math.max(arm.sy * 0.25, 0.1);

        playerBoxes[side + " Hand"] = {
            xmin: arm.xmin,
            xmax: arm.xmax,
            ymin: arm.ymin,
            ymax: arm.ymin + height,
            zmin: arm.zmin,
            zmax: arm.zmax,
            cx: arm.cx,
            cy: arm.ymin + height / 2,
            cz: arm.cz,
            sx: arm.sx,
            sy: height,
            sz: arm.sz
        };
    }

    return playerBoxes;
}

function assignHandleBone(handleGroup, playerBoxes, positions, options = {}) {
    const allowLegs = Boolean(options.allowLegs);
    const handleBox = computeBox(handleGroup.vertexIndices, positions);

    if (!Number.isFinite(handleBox.cx)) {
        return null;
    }

    const center = { x: handleBox.cx, y: handleBox.cy, z: handleBox.cz };
    const rigType =
        playerBoxes.LowerTorso || playerBoxes.UpperTorso ? "R15" : "R6";
    const torsoBox =
        playerBoxes.UpperTorso || playerBoxes.LowerTorso || playerBoxes.Torso;
    const torsoHalf = torsoBox ? torsoBox.sx / 2 : 0;
    const central =
        Math.abs(center.x - (torsoBox ? torsoBox.cx : 0)) <=
        Math.max(torsoHalf * 1.1, 0.25);
    const belowWaist = torsoBox ? center.y < torsoBox.cy : false;

    let bestPart = null;
    let bestScore = Infinity;

    for (const [part, box] of Object.entries(playerBoxes)) {
        let score = distanceToBox(center, box);

        // Items hanging near a leg are usually tails / waist / back accessories.
        if (!allowLegs && /Leg|Foot/.test(part)) {
            score *= 2.5;
        }

        // Arm and hand items only make sense when they sit outside the torso.
        if (/Arm|Hand/.test(part) && central) {
            score *= 2;
        }

        if (score < bestScore) {
            bestScore = score;
            bestPart = part;
        }
    }

    if (!bestPart) {
        return null;
    }

    // Anatomical cleanup: legs are not valid attachment points for accessories;
    // a tail or waist item belongs to the hips, and a central low item is never
    // a head/arm accessory.
    let finalPart = bestPart;
    if (!allowLegs && /Leg|Foot/.test(bestPart)) {
        finalPart = hipsPart(rigType);
    } else if (central && belowWaist && /Head|Arm|Hand/.test(bestPart)) {
        finalPart = hipsPart(rigType);
    }

    // Leave far-flung props unparented (still centered) instead of snapping
    // them to an unrelated bone.
    const finalBox = playerBoxes[finalPart];
    if (finalBox && Number.isFinite(finalBox.cx)) {
        const rawDist = distanceToBox(center, finalBox);
        const limit = Math.max(finalBox.sx, finalBox.sy, finalBox.sz) * 1.5;
        if (rawDist > limit) {
            return null;
        }
    }

    return finalPart;
}

// Roblox often merges disconnected accessory pieces into one OBJ group (for
// example, sleeves covering both arms). Positions are duplicated per face, so
// weld by position before looking for connected components.
function weldedComponents(group, parsed, epsilon = 1e-4) {
    const keyFor = (vertexIndex) => {
        const x = parsed.positions[vertexIndex * 3];
        const y = parsed.positions[vertexIndex * 3 + 1];
        const z = parsed.positions[vertexIndex * 3 + 2];
        return `${Math.round(x / epsilon)}|${Math.round(y / epsilon)}|${Math.round(z / epsilon)}`;
    };

    const parent = new Map();
    const find = (key) => {
        if (!parent.has(key)) {
            parent.set(key, key);
            return key;
        }
        let root = key;
        while (parent.get(root) !== root) {
            root = parent.get(root);
        }
        while (key !== root) {
            const next = parent.get(key);
            parent.set(key, root);
            key = next;
        }
        return root;
    };
    const union = (a, b) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) {
            parent.set(rootA, rootB);
        }
    };

    const faceRoots = [];
    for (const faceIndex of group.faceIndices) {
        const face = parsed.faces[faceIndex];
        const keys = face.verts.map(keyFor);
        for (let i = 1; i < keys.length; i++) {
            union(keys[0], keys[i]);
        }
        faceRoots.push({ faceIndex, key: keys[0], verts: face.verts });
    }

    const components = new Map();
    for (const entry of faceRoots) {
        const root = find(entry.key);
        let component = components.get(root);
        if (!component) {
            component = { faceIndices: [], vertexSet: new Set() };
            components.set(root, component);
        }
        component.faceIndices.push(entry.faceIndex);
        for (const vertex of entry.verts) {
            component.vertexSet.add(vertex);
        }
    }

    return Array.from(components.values()).map((component) => ({
        faceIndices: component.faceIndices,
        vertexIndices: Array.from(component.vertexSet).sort((a, b) => a - b)
    }));
}

function boxGap(a, b) {
    const dx = Math.max(a.xmin - b.xmax, 0, b.xmin - a.xmax);
    const dy = Math.max(a.ymin - b.ymax, 0, b.ymin - a.ymax);
    const dz = Math.max(a.zmin - b.zmax, 0, b.zmin - a.zmax);
    return Math.hypot(dx, dy, dz);
}

// Disconnected islands can still be parts of one physical object (a skirt made
// from separate panels), or truly separate objects (left and right sleeves).
// Merge islands whose bounding boxes touch or nearly touch, scaled to the
// handle size so custom body proportions keep working.
function spatialComponentClusters(components, parsed, groupBox) {
    if (components.length <= 1) {
        return components.length ? [components] : [];
    }

    const groupSize = Math.max(groupBox.sx, groupBox.sy, groupBox.sz) || 1;
    const threshold = Math.max(0.02, groupSize * 0.12);
    const boxes = components.map((component) =>
        computeBox(component.vertexIndices, parsed.positions)
    );
    const parent = components.map((_, index) => index);

    const find = (index) => {
        let root = index;
        while (parent[root] !== root) root = parent[root];
        while (parent[index] !== root) {
            const next = parent[index];
            parent[index] = root;
            index = next;
        }
        return root;
    };
    const union = (a, b) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent[rootA] = rootB;
    };

    for (let i = 0; i < components.length; i++) {
        for (let j = i + 1; j < components.length; j++) {
            if (boxGap(boxes[i], boxes[j]) <= threshold) {
                union(i, j);
            }
        }
    }

    const clusters = new Map();
    for (let i = 0; i < components.length; i++) {
        const root = find(i);
        if (!clusters.has(root)) clusters.set(root, []);
        clusters.get(root).push(components[i]);
    }

    return Array.from(clusters.values());
}

// A full-body outfit is exported as islands for both the upper and lower body
// (torso/sleeves plus trouser legs). Only those should follow individual bones.
// A skirt occupies the lower body only and must stay one object on the hips;
// sleeves occupy the arms only and are handled as separate islands.
function accessoryIsFullBodyOutfit(components, parsed, playerBoxes) {
    let upperFaces = 0;
    let lowerFaces = 0;
    let totalFaces = 0;

    for (const component of components) {
        totalFaces += component.faceIndices.length;
        const part = assignHandleBone(
            { vertexIndices: component.vertexIndices },
            playerBoxes,
            parsed.positions,
            { allowLegs: true }
        );

        if (!part) continue;

        if (/UpperTorso|Head|UpperArm|LowerArm/.test(part)) {
            upperFaces += component.faceIndices.length;
        } else if (/LowerTorso|Leg|Foot/.test(part)) {
            lowerFaces += component.faceIndices.length;
        }
    }

    return totalFaces > 0 &&
        upperFaces / totalFaces >= 0.1 &&
        lowerFaces / totalFaces >= 0.1;
}

function buildFaceGraph(group, parsed) {
    const epsilon = 1e-4;
    const keyFor = (vertexIndex) => {
        const x = parsed.positions[vertexIndex * 3];
        const y = parsed.positions[vertexIndex * 3 + 1];
        const z = parsed.positions[vertexIndex * 3 + 2];
        return `${Math.round(x / epsilon)}|${Math.round(y / epsilon)}|${Math.round(z / epsilon)}`;
    };

    const entries = [];
    const edgeFaces = new Map();

    for (const faceIndex of group.faceIndices) {
        const face = parsed.faces[faceIndex];
        const keys = face.verts.map(keyFor);
        let cx = 0;
        let cy = 0;
        let cz = 0;

        for (const vertex of face.verts) {
            cx += parsed.positions[vertex * 3];
            cy += parsed.positions[vertex * 3 + 1];
            cz += parsed.positions[vertex * 3 + 2];
        }

        const count = face.verts.length || 1;
        entries.push({
            faceIndex,
            vertices: face.verts,
            centroid: { x: cx / count, y: cy / count, z: cz / count }
        });

        for (let i = 0; i < keys.length; i++) {
            const a = keys[i];
            const b = keys[(i + 1) % keys.length];
            const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
            if (!edgeFaces.has(edge)) edgeFaces.set(edge, []);
            edgeFaces.get(edge).push(entries.length - 1);
        }
    }

    const adjacency = entries.map(() => new Set());
    for (const faces of edgeFaces.values()) {
        for (let i = 0; i < faces.length; i++) {
            for (let j = i + 1; j < faces.length; j++) {
                adjacency[faces[i]].add(faces[j]);
                adjacency[faces[j]].add(faces[i]);
            }
        }
    }

    return { entries, adjacency };
}

function labelComponents(entries, adjacency, labels) {
    const seen = new Uint8Array(entries.length);
    const components = [];

    for (let start = 0; start < entries.length; start++) {
        if (seen[start]) continue;
        const label = labels[start];
        const stack = [start];
        const faces = [];
        seen[start] = 1;

        while (stack.length) {
            const index = stack.pop();
            faces.push(index);
            for (const neighbor of adjacency[index]) {
                if (!seen[neighbor] && labels[neighbor] === label) {
                    seen[neighbor] = 1;
                    stack.push(neighbor);
                }
            }
        }

        components.push({ label, faces });
    }

    return components;
}

function mergeSmallComponents(entries, adjacency, labels, minFaces) {
    let changed = false;

    for (let pass = 0; pass < 2; pass++) {
        const components = labelComponents(entries, adjacency, labels);
        let passChanged = false;

        for (const component of components) {
            if (component.faces.length >= minFaces) continue;

            const members = new Set(component.faces);
            const neighborCounts = new Map();

            for (const index of component.faces) {
                for (const neighbor of adjacency[index]) {
                    if (members.has(neighbor)) continue;
                    const label = labels[neighbor];
                    neighborCounts.set(label, (neighborCounts.get(label) || 0) + 1);
                }
            }

            let replacement = null;
            let best = 0;
            for (const [label, count] of neighborCounts) {
                if (count > best) {
                    best = count;
                    replacement = label;
                }
            }

            if (replacement !== null) {
                for (const index of component.faces) {
                    labels[index] = replacement;
                }
                passChanged = true;
            }
        }

        changed = changed || passChanged;
        if (!passChanged) break;
    }

    return changed;
}

// Segment one connected surface by body-part proximity. This is intentionally
// conservative: low confidence or tiny regions preserve the original group.
function segmentConnectedGroup(group, parsed, playerBoxes) {
    if (group.faceCount < 8) {
        return null;
    }

    const { entries, adjacency } = buildFaceGraph(group, parsed);
    if (entries.length < 8) {
        return null;
    }

    const groupBox = computeBox(group.vertexIndices, parsed.positions);
    if (!Number.isFinite(groupBox.cx)) {
        return null;
    }

    const groupSize = Math.max(groupBox.sx, groupBox.sy, groupBox.sz);
    const gapLimit = Math.max(0.05, groupSize * 0.05);
    const candidates = Object.entries(playerBoxes)
        .filter(([, box]) => box && Number.isFinite(box.cx))
        .filter(([, box]) => boxGap(groupBox, box) <= gapLimit)
        .map(([part, box]) => ({ part, box }));

    if (candidates.length < 2) {
        return null;
    }

    const labels = new Array(entries.length);
    const margins = new Array(entries.length);
    let ambiguous = 0;
    const ambiguityThreshold = Math.max(0.01, groupSize * 0.015);

    for (let i = 0; i < entries.length; i++) {
        const point = entries[i].centroid;
        const scores = candidates.map((candidate) => ({
            part: candidate.part,
            distance: distanceToBox(point, candidate.box)
                + Math.hypot(
                    point.x - candidate.box.cx,
                    point.y - candidate.box.cy,
                    point.z - candidate.box.cz
                ) * 0.01
        }));
        scores.sort((a, b) => a.distance - b.distance);
        labels[i] = scores[0].part;
        margins[i] = scores.length > 1
            ? scores[1].distance - scores[0].distance
            : Infinity;
        if (margins[i] <= ambiguityThreshold) {
            ambiguous += 1;
        }
    }

    // Smooth ambiguous faces toward their neighbours without moving strongly
    // classified faces.
    for (let pass = 0; pass < 4; pass++) {
        const next = labels.slice();

        for (let i = 0; i < entries.length; i++) {
            if (margins[i] > ambiguityThreshold) continue;

            const counts = new Map();
            for (const neighbor of adjacency[i]) {
                counts.set(labels[neighbor], (counts.get(labels[neighbor]) || 0) + 1);
            }

            let bestLabel = labels[i];
            let bestCount = counts.get(labels[i]) || 0;
            for (const [label, count] of counts) {
                if (count > bestCount) {
                    bestLabel = label;
                    bestCount = count;
                }
            }
            next[i] = bestLabel;
        }

        labels.splice(0, labels.length, ...next);
    }

    const totalFaces = entries.length;
    const minFaces = Math.max(6, Math.floor(totalFaces * 0.03));
    mergeSmallComponents(entries, adjacency, labels, minFaces);

    const byPart = new Map();
    for (let i = 0; i < entries.length; i++) {
        const label = labels[i];
        if (!byPart.has(label)) byPart.set(label, []);
        byPart.get(label).push(entries[i].faceIndex);
    }

    const significant = [...byPart.entries()]
        .filter(([, faceIndices]) => faceIndices.length >= minFaces);

    if (significant.length < 2) {
        return null;
    }

    // Any remaining tiny label is folded into the nearest significant part.
    const significantParts = new Set(significant.map(([part]) => part));
    for (const [part, faceIndices] of byPart) {
        if (significantParts.has(part)) continue;
        const target = significant[0][0];
        for (const faceIndex of faceIndices) {
            byPart.get(target).push(faceIndex);
        }
        byPart.delete(part);
    }

    const confidence = totalFaces > 0
        ? Math.max(0, Math.min(1, 1 - ambiguous / totalFaces))
        : 0;

    if (confidence < 0.35) {
        return null;
    }

    // Re-label each region by its aggregate geometry. A region is only trusted
    // when it is actually localized on the body part it was assigned to; a
    // stray patch (a long hair strand reaching the torso, for example) is not
    // a real region boundary and must not fragment the accessory.
    const partBoxes = new Map(candidates.map((candidate) => [candidate.part, candidate.box]));
    const relabeled = new Map();

    for (const [label, faceIndices] of byPart) {
        const vertexSet = new Set();
        for (const faceIndex of faceIndices) {
            const face = parsed.faces[faceIndex];
            for (const vertex of face.verts) vertexSet.add(vertex);
        }

        const segmentBox = computeBox(Array.from(vertexSet), parsed.positions);
        if (!Number.isFinite(segmentBox.cx)) {
            return null;
        }

        let assigned = label;
        let bestScore = Infinity;
        for (const candidate of candidates) {
            const center = {
                x: segmentBox.cx,
                y: segmentBox.cy,
                z: segmentBox.cz
            };
            const score = distanceToBox(center, candidate.box)
                + Math.hypot(
                    segmentBox.cx - candidate.box.cx,
                    segmentBox.cy - candidate.box.cy,
                    segmentBox.cz - candidate.box.cz
                ) * 0.01;
            if (score < bestScore) {
                bestScore = score;
                assigned = candidate.part;
            }
        }

        const targetBox = partBoxes.get(assigned);
        const partSize = Math.max(targetBox.sx, targetBox.sy, targetBox.sz);
        const gap = boxGap(segmentBox, targetBox);
        const gapLimitForPart = Math.max(partSize * 0.25, groupSize * 0.05);

        if (gap > gapLimitForPart) {
            return null;
        }

        if (!relabeled.has(assigned)) relabeled.set(assigned, []);
        const bucket = relabeled.get(assigned);
        for (const faceIndex of faceIndices) bucket.push(faceIndex);
    }

    if (relabeled.size < 2) {
        return null;
    }

    return {
        confidence,
        groups: [...relabeled.entries()].map(([part, faceIndices]) => ({
            part,
            faceIndices
        }))
    };
}

// Split a merged handle into one virtual group per attached body part. Groups
// whose components all belong to the same part are kept intact.
function splitHandleGroups(parsed, playerBoxes, { segmentConnected = false } = {}) {
    // The parsed mesh may be handed to rigging more than once (conversion plus
    // part discovery); splitting must remain idempotent.
    if (parsed._handleSplitDone) {
        return false;
    }
    parsed._handleSplitDone = true;

    let changed = false;
    const groups = [];

    for (const group of parsed.groups) {
        if (!/^Handle/i.test(group.name) || group.faceCount < 2) {
            groups.push(group);
            continue;
        }

        const components = weldedComponents(group, parsed);
        group.weldedComponentCount = components.length;
        if (components.length < 2) {
            groups.push(group);
            continue;
        }

        const fullBody = accessoryIsFullBodyOutfit(components, parsed, playerBoxes);
        group.spansUpperBody = fullBody;

        const byPart = new Map();

        if (fullBody) {
            // Full-body outfit: each island belongs to the body part it covers,
            // including legs and feet.
            for (const component of components) {
                const part = assignHandleBone(
                    { vertexIndices: component.vertexIndices },
                    playerBoxes,
                    parsed.positions,
                    { allowLegs: true }
                ) || "Other";

                if (!byPart.has(part)) {
                    byPart.set(part, []);
                }
                byPart.get(part).push([component]);
            }
        } else {
            // Lower-body garment or limb accessory: merge overlapping panels.
            const clusters = spatialComponentClusters(
                components,
                parsed,
                computeBox(group.vertexIndices, parsed.positions)
            );
            group.spatialClusterCount = clusters.length;

            if (clusters.length < 2) {
                groups.push(group);
                continue;
            }

            for (const cluster of clusters) {
                const vertexIndices = [];
                const seen = new Set();

                for (const component of cluster) {
                    for (const vertex of component.vertexIndices) {
                        if (!seen.has(vertex)) {
                            seen.add(vertex);
                            vertexIndices.push(vertex);
                        }
                    }
                }

                const part = assignHandleBone(
                    { vertexIndices },
                    playerBoxes,
                    parsed.positions
                ) || "Other";

                if (!byPart.has(part)) {
                    byPart.set(part, []);
                }
                byPart.get(part).push(cluster);
            }
        }

        if (byPart.size < 2) {
            groups.push(group);
            continue;
        }

        for (const [part, partClusters] of byPart) {
            const faceIndices = [];
            const vertexSet = new Set();

            for (const cluster of partClusters) {
                for (const component of cluster) {
                    for (const faceIndex of component.faceIndices) {
                        faceIndices.push(faceIndex);
                    }
                    for (const vertex of component.vertexIndices) {
                        vertexSet.add(vertex);
                    }
                }
            }

            const splitGroup = {
                ...group,
                name: `${group.name}_${part.replace(/\s+/g, "")}`,
                baseName: group.name,
                splitPart: part,
                faceIndices,
                vertexIndices: Array.from(vertexSet).sort((a, b) => a - b),
                faceCount: faceIndices.length,
                weldedComponentCount: partClusters.reduce(
                    (sum, cluster) => sum + cluster.length,
                    0
                )
            };
            groups.push(splitGroup);
            changed = true;
        }
    }

    if (changed) {
        parsed.groups = groups;
    }

    // Optional second stage: cut one connected surface by body region. It is
    // off by default because connected garments (dresses, thobes, skirts) are
    // usually one intended object, and cutting them makes them break apart.
    let connectedChanged = false;

    if (segmentConnected) {
        const segmentedGroups = [];

        for (const group of parsed.groups) {
            if (
                !/^Handle/i.test(group.name) ||
                group.faceCount < 8 ||
                (group.weldedComponentCount || 1) > 1
            ) {
                segmentedGroups.push(group);
                continue;
            }

            const segmented = segmentConnectedGroup(group, parsed, playerBoxes);
            if (!segmented || segmented.groups.length < 2) {
                segmentedGroups.push(group);
                continue;
            }

            const baseName = group.baseName || group.name;
            for (const segment of segmented.groups) {
                const vertexSet = new Set();
                for (const faceIndex of segment.faceIndices) {
                    const face = parsed.faces[faceIndex];
                    for (const vertex of face.verts) {
                        vertexSet.add(vertex);
                    }
                }

                segmentedGroups.push({
                    ...group,
                    name: `${baseName}_${segment.part.replace(/\s+/g, "")}`,
                    baseName,
                    splitPart: segment.part,
                    faceIndices: segment.faceIndices,
                    vertexIndices: Array.from(vertexSet).sort((a, b) => a - b),
                    faceCount: segment.faceIndices.length,
                    segmentationConfidence: segmented.confidence
                });
                connectedChanged = true;
            }
        }

        if (connectedChanged) {
            parsed.groups = segmentedGroups;
        }
    }

    if (changed || connectedChanged) {
        // Connected segmentation can return a region that a disconnected split
        // already produced. Merge equal names so exports never contain two
        // nodes with the same identity.
        const mergedGroups = [];
        const byName = new Map();

        for (const group of parsed.groups) {
            const existing = byName.get(group.name);

            if (!existing) {
                byName.set(group.name, group);
                mergedGroups.push(group);
                continue;
            }

            const seenFaces = new Set(existing.faceIndices);
            for (const faceIndex of group.faceIndices) {
                if (!seenFaces.has(faceIndex)) {
                    seenFaces.add(faceIndex);
                    existing.faceIndices.push(faceIndex);
                }
            }

            const vertexSet = new Set(existing.vertexIndices);
            for (const vertex of group.vertexIndices) vertexSet.add(vertex);
            existing.vertexIndices = Array.from(vertexSet).sort((a, b) => a - b);
            existing.faceCount = existing.faceIndices.length;

            if (Number.isFinite(group.segmentationConfidence)) {
                existing.segmentationConfidence = Number.isFinite(existing.segmentationConfidence)
                    ? Math.min(existing.segmentationConfidence, group.segmentationConfidence)
                    : group.segmentationConfidence;
            }
        }

        parsed.groups = mergedGroups;
        const finalSplits = {};

        for (const group of mergedGroups) {
            if (!/^Handle/i.test(group.name)) continue;
            const baseName = group.baseName || group.name;
            if (baseName !== group.name || group.splitPart) {
                if (!finalSplits[baseName]) finalSplits[baseName] = [];
                finalSplits[baseName].push(group);
            }
        }

        parsed._handleSplits = finalSplits;
    }

    return changed || connectedChanged;
}

function createAccessor(doc, buffer, array, typeStr, componentType, normalized = false) {
    const acc = doc.createAccessor();
    acc.setType(typeStr);
    acc.set("componentType", componentType);
    acc.setArray(array);
    acc.setNormalized(normalized);
    acc.setBuffer(buffer);
    return acc;
}

// Append without blowing the call stack on very large (subdivided) meshes.
function pushAll(target, source) {
    const CHUNK = 8192;

    for (let i = 0; i < source.length; i += CHUNK) {
        target.push(...source.slice(i, i + CHUNK));
    }
}

// R6 limbs are single meshes; when the extra joints exist, spread each vertex
// across the upper/lower/end bones along the limb axis so elbows/knees bend.
const LIMB_BONES = {
    "Left Arm": ["Left Arm", "Left LowerArm", "Left Hand"],
    "Right Arm": ["Right Arm", "Right LowerArm", "Right Hand"],
    "Left Leg": ["Left Leg", "Left LowerLeg", "Left Foot"],
    "Right Leg": ["Right Leg", "Right LowerLeg", "Right Foot"]
};

function createSkinner(joints, boneNameToIdx) {
    const limbSkinFor = (boneName) => {
        const bones = LIMB_BONES[boneName];

        if (!bones) {
            return null;
        }

        for (const name of bones) {
            if (!joints[name] || boneNameToIdx[name] === undefined) {
                return null;
            }
        }

        return bones;
    };

    const limbWeightsFor = (bones, px, py, pz) => {
        const j0 = joints[bones[0]];
        const j1 = joints[bones[1]];
        const j2 = joints[bones[2]];

        const ax = j1[0] - j0[0];
        const ay = j1[1] - j0[1];
        const az = j1[2] - j0[2];
        const seg1 = Math.hypot(ax, ay, az) || 1e-6;
        const ux = ax / seg1;
        const uy = ay / seg1;
        const uz = az / seg1;
        const seg2 = Math.hypot(j2[0] - j1[0], j2[1] - j1[1], j2[2] - j1[2]) || 1e-6;

        const s = (px - j0[0]) * ux + (py - j0[1]) * uy + (pz - j0[2]) * uz;
        const t1 = seg1;
        const t2 = seg1 + seg2;

        // Symmetric blend half-width capped to half the shorter segment so the
        // elbow/knee and wrist/ankle blends never overlap.
        const w = Math.max(Math.min(seg1, seg2) * 0.45, 1e-3);
        // Smoothstep keeps the transition soft at both ends of the blend, which
        // removes the linear-skinning pinch when a joint bends.
        const smooth = (f) => f * f * (3 - 2 * f);

        let w0 = 0;
        let w1 = 0;
        let w2 = 0;

        if (s <= t1 - w) {
            w0 = 1;
        } else if (s < t1 + w) {
            const f = smooth((s - (t1 - w)) / (2 * w));
            w0 = 1 - f;
            w1 = f;
        } else if (s <= t2 - w) {
            w1 = 1;
        } else if (s < t2 + w) {
            const f = smooth((s - (t2 - w)) / (2 * w));
            w1 = 1 - f;
            w2 = f;
        } else {
            w2 = 1;
        }

        return {
            joints: [
                boneNameToIdx[bones[0]],
                boneNameToIdx[bones[1]],
                boneNameToIdx[bones[2]],
                0
            ],
            weights: [w0, w1, w2, 0]
        };
    };

    return { limbSkinFor, limbWeightsFor };
}

function buildParentMap(rigType, joints) {
    const rootName = rigType === "R6" ? "HumanoidRootPart" : "Root";
    const parentOf = {};

    if (rigType === "R6") {
        parentOf.Torso = joints.Waist ? "Waist" : rootName;
        parentOf.Waist = rootName;
        parentOf.Neck = "Torso";
        parentOf.Head = "Neck";
        parentOf["Left Arm"] = "Torso";
        parentOf["Right Arm"] = "Torso";
        parentOf["Left Hand"] = joints["Left LowerArm"] ? "Left LowerArm" : "Left Arm";
        parentOf["Right Hand"] = joints["Right LowerArm"] ? "Right LowerArm" : "Right Arm";
        parentOf["Left LowerArm"] = "Left Arm";
        parentOf["Right LowerArm"] = "Right Arm";
        parentOf["Left Leg"] = rootName;
        parentOf["Right Leg"] = rootName;
        parentOf["Left LowerLeg"] = "Left Leg";
        parentOf["Right LowerLeg"] = "Right Leg";
        parentOf["Left Foot"] = joints["Left LowerLeg"] ? "Left LowerLeg" : "Left Leg";
        parentOf["Right Foot"] = joints["Right LowerLeg"] ? "Right LowerLeg" : "Right Leg";
    } else if (rigType === "R15") {
        parentOf.LowerTorso = rootName;
        parentOf.UpperTorso = "LowerTorso";
        parentOf.Neck = "UpperTorso";
        parentOf.Head = "Neck";
        parentOf["LeftUpperArm"] = "UpperTorso";
        parentOf["RightUpperArm"] = "UpperTorso";
        parentOf["LeftLowerArm"] = "LeftUpperArm";
        parentOf["RightLowerArm"] = "RightUpperArm";
        parentOf["LeftHand"] = "LeftLowerArm";
        parentOf["RightHand"] = "RightLowerArm";
        parentOf["LeftUpperLeg"] = "LowerTorso";
        parentOf["RightUpperLeg"] = "LowerTorso";
        parentOf["LeftLowerLeg"] = "LeftUpperLeg";
        parentOf["RightLowerLeg"] = "RightUpperLeg";
        parentOf["LeftFoot"] = "LeftLowerLeg";
        parentOf["RightFoot"] = "RightLowerLeg";
    }

    // Export-only tip bones are plain children of the bone named before "_tip".
    for (const name of Object.keys(joints)) {
        if (name.endsWith("_tip")) {
            parentOf[name] = name.slice(0, -4);
        }
    }

    return { parentOf, rootName };
}

// Importers such as Blender and Unity guess a leaf bone's length and direction
// from its parent, which stretched R6 hands down to the floor. Terminal
// hand/foot bones get a short child tip so they get a real, small length.
// Export-only: the explorer and /parts endpoint build bones from
// computeJoints, so their rig trees stay free of tips.
function addTerminalTips(joints, parentOf) {
    const TIP = 0.15;
    const parented = new Set();

    for (const [child, parent] of Object.entries(parentOf)) {
        if (joints[child] && joints[parent]) parented.add(parent);
    }

    for (const name of Object.keys(joints)) {
        if (parented.has(name) || /head/i.test(name) || !/(hand|foot)/i.test(name)) {
            continue;
        }

        const j = joints[name];
        const p = joints[parentOf[name]];
        let dx = 0;
        let dy = -1;
        let dz = 0;

        if (p) {
            dx = j[0] - p[0];
            dy = j[1] - p[1];
            dz = j[2] - p[2];

            const len = Math.hypot(dx, dy, dz);

            if (len > 1e-6) {
                dx /= len;
                dy /= len;
                dz /= len;
            } else {
                dx = 0;
                dy = -1;
                dz = 0;
            }
        }

        const tipName = `${name}_tip`;
        joints[tipName] = [j[0] + dx * TIP, j[1] + dy * TIP, j[2] + dz * TIP];
        parentOf[tipName] = name;
    }
}

// Minimal quaternion helpers for orienting GLB joints.
const Q_IDENTITY = [0, 0, 0, 1];

function qNormalize(q) {
    const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function qMultiply(a, b) {
    return [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
}

function qConjugate(q) {
    return [-q[0], -q[1], -q[2], q[3]];
}

function qRotate(q, v) {
    const [x, y, z, w] = q;
    const ix = w * v[0] + y * v[2] - z * v[1];
    const iy = w * v[1] + z * v[0] - x * v[2];
    const iz = w * v[2] + x * v[1] - y * v[0];
    const iw = -x * v[0] - y * v[1] - z * v[2];
    return [
        ix * w + iw * -x + iy * -z - iz * -y,
        iy * w + iw * -y + iz * -x - ix * -z,
        iz * w + iw * -z + ix * -y - iy * -x
    ];
}

function qFromUnitVectors(from, to) {
    let r = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + 1;

    if (r < 1e-8) {
        r = 0;
        if (Math.abs(from[0]) > Math.abs(from[2])) {
            return qNormalize([-from[1], from[0], 0, 0]);
        }
        return qNormalize([0, -from[2], from[1], 0]);
    }

    return qNormalize([
        from[1] * to[2] - from[2] * to[1],
        from[2] * to[0] - from[0] * to[2],
        from[0] * to[1] - from[1] * to[0],
        r
    ]);
}

// Identify accessories authored with inverted winding/normals. Roblox uses
// this for outline effects; those materials must stay single-sided so the
// culling effect survives the GLB/GLTF export instead of being flattened by
// double-sided rendering.
function orientationStatsForGroup(group, parsed) {
    const { positions, faces } = parsed;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let count = 0;

    for (const vertexIndex of group.vertexIndices) {
        cx += positions[vertexIndex * 3];
        cy += positions[vertexIndex * 3 + 1];
        cz += positions[vertexIndex * 3 + 2];
        count += 1;
    }

    if (!count) {
        return null;
    }

    cx /= count;
    cy /= count;
    cz /= count;

    let volume = 0;
    let outward = 0;
    let inward = 0;

    for (const faceIndex of group.faceIndices) {
        const face = faces[faceIndex];
        const verts = face.verts;
        if (!verts || verts.length < 3) continue;

        const point = (index) => [
            positions[verts[index] * 3],
            positions[verts[index] * 3 + 1],
            positions[verts[index] * 3 + 2]
        ];

        const a = point(0);

        for (let i = 1; i + 1 < verts.length; i++) {
            const b = point(i);
            const c = point(i + 1);
            volume += (
                a[0] * (b[1] * c[2] - b[2] * c[1]) +
                a[1] * (b[2] * c[0] - b[0] * c[2]) +
                a[2] * (b[0] * c[1] - b[1] * c[0])
            ) / 6;
        }

        let nx;
        let ny;
        let nz;

        if (face.norms && face.norms[0] >= 0 && parsed.normals.length > face.norms[0] * 3 + 2) {
            nx = parsed.normals[face.norms[0] * 3];
            ny = parsed.normals[face.norms[0] * 3 + 1];
            nz = parsed.normals[face.norms[0] * 3 + 2];
        } else {
            const b = point(1);
            const c = point(2);
            const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            nx = ab[1] * ac[2] - ab[2] * ac[1];
            ny = ab[2] * ac[0] - ab[0] * ac[2];
            nz = ab[0] * ac[1] - ab[1] * ac[0];
        }

        const length = Math.hypot(nx, ny, nz);
        if (length < 1e-9) continue;

        let fx = 0;
        let fy = 0;
        let fz = 0;
        for (const vertexIndex of verts) {
            fx += positions[vertexIndex * 3];
            fy += positions[vertexIndex * 3 + 1];
            fz += positions[vertexIndex * 3 + 2];
        }
        fx = fx / verts.length - cx;
        fy = fy / verts.length - cy;
        fz = fz / verts.length - cz;

        const direction = nx * fx + ny * fy + nz * fz;
        if (direction > 0) outward += 1;
        else if (direction < 0) inward += 1;
    }

    return { volume, outward, inward };
}

function buildDocument(parsed, partMapping, joints, offsetX, offsetY, offsetZ, rigType, handleBoneMap, options = {}) {
    const splitParts = !!options.splitParts;
    const groupName = options.groupName || "Avatar";
    const rigData = options.rigData || null;
    const { positions, normals, uvs, vertexColors, groups, faces } = parsed;
    const rigged = !!rigType;

    const doc = new Document();
    const root = doc.getRoot();
    const scene = doc.createScene("Scene");
    const buffer = doc.createBuffer();
    const materialMap = Object.create(null);
    const materialOrientation = new Map();

    for (const g of groups) {
        const stats = orientationStatsForGroup(g, parsed);
        if (!stats) continue;
        const current = materialOrientation.get(g.material) || {
            volume: 0,
            outward: 0,
            inward: 0
        };
        current.volume += stats.volume;
        current.outward += stats.outward;
        current.inward += stats.inward;
        materialOrientation.set(g.material, current);
    }

    for (const g of groups) {
        const matName = g.material;
        if (materialMap[matName]) continue;

        const mtl = parsed._mtls[matName] || { Kd: [0.8, 0.8, 0.8], map_Kd: null, opacity: 1 };
        const mat = doc.createMaterial(matName);
        const opacity = Number.isFinite(mtl.opacity) ? mtl.opacity : 1;

        if (mtl.map_Kd) {
            const texPath = resolveAssetTexture(parsed._assetDir, mtl.map_Kd);
            if (texPath && fs.existsSync(texPath)) {
                const pngData = fs.readFileSync(texPath);
                const tex = doc.createTexture(matName + "_tex")
                    .setMimeType("image/png")
                    .setImage(pngData);
                mat.setBaseColorTexture(tex);
            }
            // White baseColorFactor so texture colors show unmodified (Kd would tint).
            mat.setBaseColorFactor([1, 1, 1, opacity]);
        } else {
            mat.setBaseColorFactor([...mtl.Kd, opacity]);
        }

        if (opacity < 1) {
            mat.setAlphaMode(Material.AlphaMode.BLEND);
        }
        // Roblox exports some accessories with inverted winding. Keep those
        // single-sided so the intended outline/flipped-normal effect survives
        // export; ordinary accessories stay double-sided.
        const orientation = materialOrientation.get(matName);
        const orientedFaces = orientation
            ? orientation.outward + orientation.inward
            : 0;
        const inwardRatio = orientedFaces > 0
            ? orientation.inward / orientedFaces
            : 0;
        const invertedEffect = !!orientation &&
            orientation.volume < 0 &&
            inwardRatio >= 0.7;
        mat.setDoubleSided(!invertedEffect);
        materialMap[matName] = mat;
    }
    const jointNodeMap = {};
    const jointNames = rigged ? Object.keys(joints) : [];

    const { parentOf, rootName } = buildParentMap(rigType, joints);

    for (const jname of jointNames) {
        const absPos = joints[jname];
        const parent = parentOf[jname];
        let translation;
        if (jname === rootName) {
            translation = [...absPos];
        } else if (parent && joints[parent]) {
            const pPos = joints[parent];
            translation = [
                absPos[0] - pPos[0],
                absPos[1] - pPos[1],
                absPos[2] - pPos[2]
            ];
        } else {
            translation = [...absPos];
        }
        const node = doc.createNode(jname);
        node.setTranslation(translation);
        jointNodeMap[jname] = node;
    }

    // glTF has no bone tail, so importers draw each bone along the node's
    // local +Y. Orient every joint toward its first child (leaves continue the
    // parent's direction) so arm/leg bones follow the limbs instead of staying
    // axis-aligned.
    const jointWorldQuat = {};
    if (rigged) {
        const childrenOf = {};
        for (const name of jointNames) {
            const p = parentOf[name];
            if (p && jointNodeMap[p]) {
                (childrenOf[p] = childrenOf[p] || []).push(name);
            }
        }

        const head = {};
        for (const name of jointNames) head[name] = joints[name];

        const yAxis = [0, 1, 0];

        const parentWorldQuat = (name) =>
            jointWorldQuat[parentOf[name]] || Q_IDENTITY;

        const orient = (name) => {
            const kids = childrenOf[name] || [];
            let dir;

            if (kids.length) {
                const h = head[name];
                const k = head[kids[0]];
                dir = [k[0] - h[0], k[1] - h[1], k[2] - h[2]];
                const len = Math.hypot(dir[0], dir[1], dir[2]);

                if (len < 1e-8) {
                    dir = qRotate(parentWorldQuat(name), yAxis);
                } else {
                    dir = [dir[0] / len, dir[1] / len, dir[2] / len];
                }
            } else {
                dir = qRotate(parentWorldQuat(name), yAxis);
            }

            const desired = qFromUnitVectors(yAxis, dir);
            jointWorldQuat[name] = desired;

            const node = jointNodeMap[name];
            const parentName = parentOf[name];

            if (parentName && jointNodeMap[parentName]) {
                const pq = parentWorldQuat(name);
                node.setRotation(qMultiply(qConjugate(pq), desired));

                const inv = qConjugate(pq);
                const d = [
                    head[name][0] - head[parentName][0],
                    head[name][1] - head[parentName][1],
                    head[name][2] - head[parentName][2]
                ];
                node.setTranslation(qRotate(inv, d));
            } else {
                node.setRotation(desired);
                node.setTranslation([...head[name]]);
            }

            for (const kid of kids) orient(kid);
        };

        if (rootName && jointNodeMap[rootName]) {
            orient(rootName);
        }
    }

    let rootNode = null;
    if (rigged) {
        rootNode = jointNodeMap[rootName];
        if (!splitParts) {
            scene.addChild(rootNode);
        }
    }

    const groupToPart = rigData && rigData.groupToPart
        ? { ...rigData.groupToPart }
        : {};

    if (!rigData || !rigData.groupToPart) {
        for (const [part, gname] of Object.entries(partMapping)) {
            groupToPart[gname] = part;
        }
    }

    if (rigged && rigType === "R6") {
        const torsoNode = jointNodeMap["Torso"];
        const waistNode = jointNodeMap["Waist"];

        if (waistNode) {
            // More joints: the torso hangs off a waist bone so it can bend.
            rootNode.addChild(waistNode);
            if (torsoNode) waistNode.addChild(torsoNode);
        } else if (torsoNode) {
            rootNode.addChild(torsoNode);
        }

        if (jointNodeMap["Neck"] && jointNodeMap["Head"]) {
            torsoNode.addChild(jointNodeMap["Neck"]);
            jointNodeMap["Neck"].addChild(jointNodeMap["Head"]);
        }
        for (const side of ["Left", "Right"]) {
            const armNode = jointNodeMap[side + " Arm"];

            if (torsoNode && armNode) {
                torsoNode.addChild(armNode);
            }

            const handNode = jointNodeMap[side + " Hand"];
            const lowerArmNode = jointNodeMap[side + " LowerArm"];

            if (armNode && lowerArmNode) {
                armNode.addChild(lowerArmNode);
                if (handNode) {
                    lowerArmNode.addChild(handNode);
                }
            } else if (armNode && handNode) {
                armNode.addChild(handNode);
            }
        }

        for (const side of ["Left", "Right"]) {
            const legNode = jointNodeMap[side + " Leg"];

            if (rootNode && legNode) {
                rootNode.addChild(legNode);
            }

            const lowerLegNode = jointNodeMap[side + " LowerLeg"];
            if (legNode && lowerLegNode) {
                legNode.addChild(lowerLegNode);
            }

            const footNode = jointNodeMap[side + " Foot"];
            if (lowerLegNode && footNode) {
                lowerLegNode.addChild(footNode);
            } else if (legNode && footNode) {
                legNode.addChild(footNode);
            }
        }
    } else if (rigged && rigType === "R15") {
        const lowerTorsoNode = jointNodeMap["LowerTorso"];
        const upperTorsoNode = jointNodeMap["UpperTorso"];
        if (lowerTorsoNode) rootNode.addChild(lowerTorsoNode);
        if (lowerTorsoNode && upperTorsoNode) lowerTorsoNode.addChild(upperTorsoNode);
        if (upperTorsoNode && jointNodeMap["Neck"] && jointNodeMap["Head"]) {
            upperTorsoNode.addChild(jointNodeMap["Neck"]);
            jointNodeMap["Neck"].addChild(jointNodeMap["Head"]);
        }
        for (const side of ["Left", "Right"]) {
            const ua = jointNodeMap[side + "UpperArm"];
            const la = jointNodeMap[side + "LowerArm"];
            const h = jointNodeMap[side + "Hand"];
            const ul = jointNodeMap[side + "UpperLeg"];
            const ll = jointNodeMap[side + "LowerLeg"];
            const f = jointNodeMap[side + "Foot"];
            if (upperTorsoNode && ua) upperTorsoNode.addChild(ua);
            if (ua && la) ua.addChild(la);
            if (la && h) la.addChild(h);
            if (lowerTorsoNode && ul) lowerTorsoNode.addChild(ul);
            if (ul && ll) ul.addChild(ll);
            if (ll && f) ll.addChild(f);
        }
    }

    // Attach export-only terminal tips to the bone they extend.
    for (const name of jointNames) {
        const node = jointNodeMap[name];
        const parentName = parentOf[name];

        if (parentName && jointNodeMap[parentName] && !node.getParentNode()) {
            jointNodeMap[parentName].addChild(node);
        }
    }
    const boneNameToIdx = {};
    jointNames.forEach((name, i) => { boneNameToIdx[name] = i; });

    const { limbSkinFor, limbWeightsFor } = createSkinner(joints, boneNameToIdx);

    const groupBuilds = [];

    let globalIndexOffset = 0;

    for (const g of groups) {
        // Handles are parented to a bone as rigid child nodes (not skinned) so
        // they stay separate, movable objects; unparented ones stay centered.
        const isHandle = Object.prototype.hasOwnProperty.call(handleBoneMap, g.name);
        const assignedBone = isHandle ? handleBoneMap[g.name] : null;
        // Layered clothing is skinned (deforms with the body); other handles
        // stay rigid children of a single bone.
        const isClothing = !!(rigData && rigData.isClothingGroup && rigData.isClothingGroup(g.name));

        const boneName = rigged
            ? (groupToPart[g.name] || assignedBone || rootName)
            : null;
        const boneIdx = rigged && boneNameToIdx[boneName] !== undefined ? boneNameToIdx[boneName] : 0;
        const limbSkin = (rigged && !isHandle) ? limbSkinFor(boneName) : null;

        // Center accessory geometry on its own pivot; the assembly node
        // translation restores the original world position. Skinned clothing
        // keeps avatar-space coordinates so its weights line up with the bones.
        let handleCenter = null;
        if (isHandle && !isClothing && splitParts) {
            const box = computeBox(g.vertexIndices, positions);
            if (Number.isFinite(box.cx)) {
                handleCenter = [box.cx - offsetX, box.cy - offsetY, box.cz - offsetZ];
            }
        }
        const hx = handleCenter ? handleCenter[0] : 0;
        const hy = handleCenter ? handleCenter[1] : 0;
        const hz = handleCenter ? handleCenter[2] : 0;

        const faceIndices = g.faceIndices;

        const cornerMap = {};
        const groupLocalPos = [];
        const groupLocalNor = [];
        const groupLocalUv = [];
        const groupLocalCol = [];
        const groupLocalJoints = [];
        const groupLocalWeights = [];
        const groupIndices = [];

        for (const fi of faceIndices) {
            const f = faces[fi];
            for (let ci = 0; ci < f.verts.length; ci++) {
                const vIdx = f.verts[ci];
                const uIdx = f.uvs[ci] !== undefined ? f.uvs[ci] : -1;
                const nIdx = f.norms[ci] !== undefined ? f.norms[ci] : -1;

                // Dedup by source vertex/UV/normal indices. This is equivalent
                // to comparing the resulting attributes, without formatting
                // floating-point strings for every corner.
                const key = `${vIdx}|${uIdx}|${nIdx}`;

                let localIdx = cornerMap[key];
                if (localIdx === undefined) {
                    localIdx = groupLocalPos.length / 3;
                    cornerMap[key] = localIdx;

                    groupLocalPos.push(
                        positions[vIdx * 3] - offsetX - hx,
                        positions[vIdx * 3 + 1] - offsetY - hy,
                        positions[vIdx * 3 + 2] - offsetZ - hz
                    );

                    if (nIdx >= 0 && normals.length > nIdx * 3) {
                        groupLocalNor.push(
                            normals[nIdx * 3], normals[nIdx * 3 + 1], normals[nIdx * 3 + 2]
                        );
                    } else {
                        groupLocalNor.push(0, 1, 0);
                    }

                    // UV — flip V for glTF convention
                    if (uIdx >= 0 && uvs.length > uIdx * 2) {
                        groupLocalUv.push(uvs[uIdx * 2], 1.0 - uvs[uIdx * 2 + 1]);
                    } else {
                        groupLocalUv.push(0, 0);
                    }

                    groupLocalCol.push(
                        vertexColors[vIdx * 4], vertexColors[vIdx * 4 + 1],
                        vertexColors[vIdx * 4 + 2], vertexColors[vIdx * 4 + 3]
                    );

                    if (rigged) {
                        if (isClothing) {
                            const skin = rigData.skinClothingFor(
                                positions[vIdx * 3],
                                positions[vIdx * 3 + 1],
                                positions[vIdx * 3 + 2]
                            );

                            groupLocalJoints.push(
                                skin.indices[0], skin.indices[1],
                                skin.indices[2], skin.indices[3]
                            );
                            groupLocalWeights.push(
                                skin.weights[0], skin.weights[1],
                                skin.weights[2], skin.weights[3]
                            );
                        } else if (limbSkin) {
                            const skin = limbWeightsFor(
                                limbSkin,
                                positions[vIdx * 3] - offsetX,
                                positions[vIdx * 3 + 1] - offsetY,
                                positions[vIdx * 3 + 2] - offsetZ
                            );

                            groupLocalJoints.push(
                                skin.joints[0], skin.joints[1],
                                skin.joints[2], skin.joints[3]
                            );
                            groupLocalWeights.push(
                                skin.weights[0], skin.weights[1],
                                skin.weights[2], skin.weights[3]
                            );
                        } else {
                            groupLocalJoints.push(boneIdx, 0, 0, 0);
                            groupLocalWeights.push(1.0, 0.0, 0.0, 0.0);
                        }
                    }
                }

                groupIndices.push(globalIndexOffset + localIdx);
            }
        }

        groupBuilds.push({
            name: g.name,
            material: g.material,
            positions: groupLocalPos,
            normals: groupLocalNor,
            uvs: groupLocalUv,
            colors: groupLocalCol,
            joints: groupLocalJoints,
            weights: groupLocalWeights,
            indices: groupIndices,
            baseIndex: globalIndexOffset,
            isHandle,
            isClothing,
            handleCenter,
            boneName: isHandle ? assignedBone : null
        });

        globalIndexOffset += groupLocalPos.length / 3;
    }

    const makeSkin = () => {
        const skin = doc.createSkin("skin");
        for (const jname of jointNames) {
            skin.addJoint(jointNodeMap[jname]);
        }
        skin.setSkeleton(rootNode);

        const ibmData = new Float32Array(jointNames.length * 16);
        for (let i = 0; i < jointNames.length; i++) {
            const name = jointNames[i];
            const jpos = joints[name];
            const inv = qConjugate(jointWorldQuat[name] || Q_IDENTITY);
            const t = qRotate(inv, [-jpos[0], -jpos[1], -jpos[2]]);
            const [x, y, z, w] = inv;

            // glTF matrices are column-major; rotation = R(q^-1).
            ibmData[i * 16 + 0] = 1 - 2 * (y * y + z * z);
            ibmData[i * 16 + 1] = 2 * (x * y + z * w);
            ibmData[i * 16 + 2] = 2 * (x * z - y * w);
            ibmData[i * 16 + 3] = 0;

            ibmData[i * 16 + 4] = 2 * (x * y - z * w);
            ibmData[i * 16 + 5] = 1 - 2 * (x * x + z * z);
            ibmData[i * 16 + 6] = 2 * (y * z + x * w);
            ibmData[i * 16 + 7] = 0;

            ibmData[i * 16 + 8] = 2 * (x * z + y * w);
            ibmData[i * 16 + 9] = 2 * (y * z - x * w);
            ibmData[i * 16 + 10] = 1 - 2 * (x * x + y * y);
            ibmData[i * 16 + 11] = 0;

            ibmData[i * 16 + 12] = t[0];
            ibmData[i * 16 + 13] = t[1];
            ibmData[i * 16 + 14] = t[2];
            ibmData[i * 16 + 15] = 1;
        }
        skin.setInverseBindMatrices(createAccessor(doc, buffer, ibmData, "MAT4", Accessor.ComponentType.FLOAT));

        return skin;
    };

    if (splitParts) {
        // Compatibility mode: one node + mesh per OBJ group, grouped under a
        // container named after the avatar. Avoids the single merged
        // "character_mesh" that some importers treat as one invisible object.
        const container = doc.createNode(groupName);
        scene.addChild(container);

        if (rigged && rootNode) {
            container.addChild(rootNode);
        }

        const skin = rigged ? makeSkin() : null;
        const usedNames = new Set();

        for (const build of groupBuilds) {
            if (build.indices.length === 0) {
                continue;
            }

            let nodeName = build.name || "part";
            let suffix = 1;
            while (usedNames.has(nodeName)) {
                suffix += 1;
                nodeName = `${build.name || "part"}_${suffix}`;
            }
            usedNames.add(nodeName);

            const partColors = new Uint8Array(build.colors.length);
            for (let i = 0; i < build.colors.length; i++) {
                partColors[i] = Math.max(0, Math.min(255, Math.round(build.colors[i] * 255)));
            }

            const prim = doc.createPrimitive()
                .setMode(4)
                .setAttribute("POSITION", createAccessor(doc, buffer, new Float32Array(build.positions), "VEC3", Accessor.ComponentType.FLOAT))
                .setAttribute("NORMAL", createAccessor(doc, buffer, new Float32Array(build.normals), "VEC3", Accessor.ComponentType.FLOAT))
                .setAttribute("TEXCOORD_0", createAccessor(doc, buffer, new Float32Array(build.uvs), "VEC2", Accessor.ComponentType.FLOAT))
                .setAttribute("COLOR_0", createAccessor(doc, buffer, partColors, "VEC4", Accessor.ComponentType.UNSIGNED_BYTE, true));

            if (rigged && (!build.isHandle || build.isClothing)) {
                prim.setAttribute("JOINTS_0", createAccessor(doc, buffer, new Uint16Array(build.joints), "VEC4", Accessor.ComponentType.UNSIGNED_SHORT));
                prim.setAttribute("WEIGHTS_0", createAccessor(doc, buffer, new Float32Array(build.weights), "VEC4", Accessor.ComponentType.FLOAT));
            }

            const localIndices = build.indices.map((index) => index - build.baseIndex);
            const needsUint32 =
                build.positions.length / 3 > 65535 || localIndices.length > 65535;
            const indexArray = needsUint32
                ? new Uint32Array(localIndices)
                : new Uint16Array(localIndices);
            const indexComponentType = needsUint32
                ? Accessor.ComponentType.UNSIGNED_INT
                : Accessor.ComponentType.UNSIGNED_SHORT;

            prim.setIndices(createAccessor(doc, buffer, indexArray, "SCALAR", indexComponentType))
                .setMaterial(materialMap[build.material] || materialMap["default"] || null);

            const partMesh = doc.createMesh(`${nodeName}_mesh`);
            partMesh.addPrimitive(prim);

            const partNode = doc.createNode(nodeName);
            partNode.setMesh(partMesh);

            if (build.isClothing) {
                // Layered clothing: a skinned mesh that deforms with the body.
                container.addChild(partNode);
                if (skin) {
                    partNode.setSkin(skin);
                }
            } else if (build.isHandle && build.handleCenter) {
                // Parent to the bone (or container if unparented); the node
                // translation compensates the bone's rest position.
                const parentJoint = build.boneName && jointNodeMap[build.boneName];
                if (parentJoint) {
                    const jp = joints[build.boneName] || [0, 0, 0];
                    const inv = qConjugate(
                        jointWorldQuat[build.boneName] || Q_IDENTITY
                    );
                    // Cancel the bone's rest rotation so the rigid accessory
                    // keeps its original world orientation and position.
                    partNode.setTranslation(qRotate(inv, [
                        build.handleCenter[0] - jp[0],
                        build.handleCenter[1] - jp[1],
                        build.handleCenter[2] - jp[2]
                    ]));
                    partNode.setRotation(inv);
                    parentJoint.addChild(partNode);
                } else {
                    partNode.setTranslation(build.handleCenter);
                    container.addChild(partNode);
                }
            } else {
                container.addChild(partNode);
                if (skin) {
                    partNode.setSkin(skin);
                }
            }
        }

        return { doc, root, scene, buffer };
    }

    // Merge every group into one mesh only for the non-split path. The split
    // path above uses the per-group buffers directly, so avoid copying them.
    const allPos = [];
    const allNor = [];
    const allUv = [];
    const allCol = [];
    const allJoints = [];
    const allWeights = [];

    for (const build of groupBuilds) {
        pushAll(allPos, build.positions);
        pushAll(allNor, build.normals);
        pushAll(allUv, build.uvs);
        pushAll(allCol, build.colors);
        if (rigged) {
            pushAll(allJoints, build.joints);
            pushAll(allWeights, build.weights);
        }
    }

    const mesh = doc.createMesh("character_mesh");

    // Convert float colors (0-1) to Uint8 (0-255) for UNSIGNED_BYTE normalized accessor.
    const colorBytes = new Uint8Array(allCol.length);
    for (let i = 0; i < allCol.length; i++) {
        colorBytes[i] = Math.max(0, Math.min(255, Math.round(allCol[i] * 255)));
    }

    const materialsUsed = [...new Set(groupBuilds.map((build) => build.material))];
    for (const matName of materialsUsed) {
        const primIndices = [];
        for (const build of groupBuilds) {
            if (build.material === matName) {
                pushAll(primIndices, build.indices);
            }
        }

        const prim = doc.createPrimitive()
            .setMode(4)
            .setAttribute("POSITION", createAccessor(doc, buffer, new Float32Array(allPos), "VEC3", Accessor.ComponentType.FLOAT))
            .setAttribute("NORMAL", createAccessor(doc, buffer, new Float32Array(allNor), "VEC3", Accessor.ComponentType.FLOAT))
            .setAttribute("TEXCOORD_0", createAccessor(doc, buffer, new Float32Array(allUv), "VEC2", Accessor.ComponentType.FLOAT))
            .setAttribute("COLOR_0", createAccessor(doc, buffer, colorBytes, "VEC4", Accessor.ComponentType.UNSIGNED_BYTE, true));

        if (rigged) {
            prim.setAttribute("JOINTS_0", createAccessor(doc, buffer, new Uint16Array(allJoints), "VEC4", Accessor.ComponentType.UNSIGNED_SHORT));
            prim.setAttribute("WEIGHTS_0", createAccessor(doc, buffer, new Float32Array(allWeights), "VEC4", Accessor.ComponentType.FLOAT));
        }

        const needsUint32 =
            allPos.length / 3 > 65535 || primIndices.length > 65535;
        const indexArray = needsUint32
            ? new Uint32Array(primIndices)
            : new Uint16Array(primIndices);
        const indexComponentType = needsUint32
            ? Accessor.ComponentType.UNSIGNED_INT
            : Accessor.ComponentType.UNSIGNED_SHORT;

        prim.setIndices(createAccessor(doc, buffer, indexArray, "SCALAR", indexComponentType))
            .setMaterial(materialMap[matName] || materialMap["default"] || null);

        mesh.addPrimitive(prim);
    }

    const meshNode = doc.createNode("character_mesh");
    meshNode.setMesh(mesh);
    scene.addChild(meshNode);
    if (rigged) {
        meshNode.setSkin(makeSkin());
    }

    return { doc, root, scene, buffer };
}

/**
 * Best-effort name of the head body group, used to keep the head out of the
 * mesh-quality subdivision. Handles both renamed exports ("Head") and raw
 * PlayerN groups (matched via body-part detection).
 */
function findHeadGroupName(parsed) {
    const direct = parsed.groups.find(
        (g) => typeof g.name === "string" && /^head$/i.test(g.name.trim())
    );

    if (direct) {
        return direct.name;
    }

    const players = parsed.groups.filter((g) => /^Player\d+$/.test(g.name));

    if (players.length) {
        const boxes = {};
        for (const g of parsed.groups) {
            boxes[g.name] = computeBox(g.vertexIndices, parsed.positions);
        }

        const mapping = matchBodyParts(players, boxes);

        if (mapping.Head) {
            return mapping.Head;
        }
    }

    return null;
}

/**
 * Compute a full R6/R15 rig from a parsed OBJ: joints (in raw OBJ space),
 * bone hierarchy, and a per-vertex skin function. Shared by the glTF and FBX
 * exporters so both produce an identical skeleton.
 */
function computeRig(parsed, { moreJoints = false, hint = null, bendAccessories = false } = {}) {
    const boxes = {};
    for (const g of parsed.groups) {
        boxes[g.name] = computeBox(g.vertexIndices, parsed.positions);
    }

    const playerGroups = parsed.groups.filter((g) => g.name.startsWith("Player"));
    let handleGroups = parsed.groups.filter((g) => g.name.startsWith("Handle"));

    const { rigType } = resolveRigType(parsed.groups, playerGroups.length, hint);
    let partMapping = {};
    let extraGroupParts = {};

    if (rigType) {
        const resolved = resolvePartMapping(parsed.groups, boxes, rigType);
        partMapping = resolved.partMapping;
        extraGroupParts = resolved.extraGroupParts;
    }

    if (!rigType) {
        throw new Error(
            `Auto-rig requires 6 (R6) or 15 (R15) body groups, found ${playerGroups.length} Player group(s)`
        );
    }

    const recenter = computeRecenter(boxes, partMapping);

    // Raw OBJ-space joints (no offset applied).
    const joints = computeJoints(
        partMapping,
        boxes,
        0,
        0,
        0,
        rigType,
        moreJoints && rigType === "R6"
    );

    const playerBoxes = {};
    for (const [part, gname] of Object.entries(partMapping)) {
        playerBoxes[part] = boxes[gname];
    }

    if (rigType === "R6") {
        addR6HandBoxes(playerBoxes);
    }

    if (splitHandleGroups(parsed, playerBoxes)) {
        handleGroups = parsed.groups.filter((g) => g.name.startsWith("Handle"));
    }

    const handleBoneMap = {};
    for (const hg of handleGroups) {
        handleBoneMap[hg.name] = hg.splitPart
            || assignHandleBone(hg, playerBoxes, parsed.positions);
    }

    const groupToPart = {};
    for (const [part, gname] of Object.entries(partMapping)) {
        groupToPart[gname] = part;
    }
    Object.assign(groupToPart, extraGroupParts);

    const { parentOf, rootName } = buildParentMap(rigType, joints);
    addTerminalTips(joints, parentOf);

    const boneNameToIdx = {};
    Object.keys(joints).forEach((name, i) => { boneNameToIdx[name] = i; });

    const { limbSkinFor, limbWeightsFor } = createSkinner(joints, boneNameToIdx);

    // Weights depend only on relative geometry, so raw-space joints + raw
    // vertex positions give the same result in any (rotated/recentered) space.
    const skinFor = (groupName, x, y, z) => {
        const boneName = groupToPart[groupName] || handleBoneMap[groupName] || rootName;
        const limbSkin = limbSkinFor(boneName);

        if (limbSkin) {
            const skin = limbWeightsFor(limbSkin, x, y, z);
            return { indices: skin.joints, weights: skin.weights };
        }

        const boneIdx = boneNameToIdx[boneName] !== undefined ? boneNameToIdx[boneName] : 0;
        return { indices: [boneIdx, 0, 0, 0], weights: [1, 0, 0, 0] };
    };

    // R15 layered-clothing skinning.
    // Accessories (Handle*) are rigid by default so hats and props keep their
    // shape. Layered clothing, however, spans several body parts and must
    // deform with the skeleton instead of sticking to one bone. A handle is
    // treated as clothing when its bounds overlap two or more body regions
    // (e.g. a jacket over the arms + torso, or trousers over both legs); those
    // vertices are skinned to the nearest bones with smooth inverse-distance
    // weights. Compact props stay rigid.
    const groupByName = {};
    for (const g of parsed.groups) {
        if (!groupByName[g.name]) {
            groupByName[g.name] = g;
        }
    }

    const partBoxes = [];
    for (const [part, gname] of Object.entries(partMapping)) {
        const pg = groupByName[gname];
        if (pg) {
            partBoxes.push({ part, box: computeBox(pg.vertexIndices, parsed.positions) });
        }
    }

    const regionOfPart = (part) => {
        if (/Head|Neck/.test(part)) return "head";
        if (/Torso/.test(part)) return "torso";
        if (/Arm|Hand/.test(part)) return part.startsWith("Left") ? "leftArm" : "rightArm";
        if (/Leg|Foot/.test(part)) return part.startsWith("Left") ? "leftLeg" : "rightLeg";
        return "other";
    };

    const boxesOverlap = (a, b) =>
        a.xmin <= b.xmax && a.xmax >= b.xmin &&
        a.ymin <= b.ymax && a.ymax >= b.ymin &&
        a.zmin <= b.zmax && a.zmax >= b.zmin;

    const isClothingGroup = (name) => {
        // "Bend accessories" off => every handle stays rigid.
        if (!bendAccessories || rigType !== "R15" || !/^handle/i.test(name)) {
            return false;
        }
        const g = groupByName[name];
        if (!g) {
            return false;
        }
        const hb = computeBox(g.vertexIndices, parsed.positions);
        if (!Number.isFinite(hb.cx)) {
            return false;
        }
        const regions = new Set();
        for (const { part, box } of partBoxes) {
            if (boxesOverlap(hb, box)) {
                regions.add(regionOfPart(part));
            }
        }
        return regions.size >= 2;
    };

    // Bone segments (head -> first child head) in raw space, used to weight
    // clothing vertices to the bones they sit closest to.
    const childrenOfBone = {};
    for (const [child, parent] of Object.entries(parentOf)) {
        if (parent && joints[parent] && !child.endsWith("_tip")) {
            (childrenOfBone[parent] = childrenOfBone[parent] || []).push(child);
        }
    }

    const boneSegmentList = [];
    for (const name of Object.keys(joints)) {
        if (name.endsWith("_tip")) {
            continue;
        }
        const idx = boneNameToIdx[name];
        if (idx === undefined) {
            continue;
        }
        const h = joints[name];
        const kids = childrenOfBone[name] || [];
        const k = kids.length ? joints[kids[0]] : null;
        boneSegmentList.push({ idx, a: h, b: k || h });
    }

    const distToSeg = (px, py, pz, a, b) => {
        const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
        const apx = px - a[0], apy = py - a[1], apz = pz - a[2];
        const len2 = abx * abx + aby * aby + abz * abz;
        let t = len2 > 1e-9 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
        return Math.hypot(dx, dy, dz);
    };

    const SKIN_POWER = 4;
    const SKIN_MAX = 4;
    const skinClothingFor = (px, py, pz) => {
        const scored = [];
        for (const b of boneSegmentList) {
            const d = distToSeg(px, py, pz, b.a, b.b);
            scored.push({ idx: b.idx, w: 1 / Math.pow(d + 0.03, SKIN_POWER) });
        }
        scored.sort((m, n) => n.w - m.w);

        const top = scored.slice(0, SKIN_MAX);
        let sum = 0;
        for (const s of top) {
            sum += s.w;
        }

        const outIndices = [0, 0, 0, 0];
        const outWeights = [0, 0, 0, 0];
        for (let i = 0; i < top.length; i++) {
            outIndices[i] = top[i].idx;
            outWeights[i] = sum > 0 ? top[i].w / sum : 0;
        }
        return { indices: outIndices, weights: outWeights };
    };

    return {
        rigType,
        partMapping,
        recenter,
        joints,
        parentOf,
        rootName,
        groupToPart,
        handleBoneMap,
        handleSplits: parsed._handleSplits || {},
        boneNameToIdx,
        skinFor,
        isClothingGroup,
        skinClothingFor
    };
}

/**
 * Convert a downloaded avatar (OBJ + MTL + textures) into a glTF document.
 *
 * @param {string} assetDir - directory containing avatar.obj / avatar.mtl / textures
 * @param {object} options
 * @param {boolean} options.rig - add R6/R15 skeleton and skinning
 * @returns {Promise<object>} { doc, rigType, jointNames, partMapping, groups, boxes, positions, normals, uvs, vertexColors, faces, mtl }
 */
async function convertAvatar(assetDir, {
    rig = false,
    splitParts = false,
    groupName = "Avatar",
    subdivision = 0,
    moreJoints = false,
    bendAccessories = false
} = {}) {
    const objPath = path.join(assetDir, "avatar.obj");
    if (!fs.existsSync(objPath)) {
        throw new Error("avatar.obj not found in " + assetDir);
    }

    const mtl = parseMtl(path.join(assetDir, "avatar.mtl"));
    const parsed = parseObj(objPath);

    if (!parsed.faces.length) {
        throw new Error("avatar.obj contains no faces");
    }

    if (subdivision > 0) {
        // Mesh quality refines the body only: accessories (Handle* groups) and
        // the head keep their original density.
        const headGroup = findHeadGroupName(parsed);
        const isExcluded = (name) =>
            typeof name === "string" &&
            (/^handle/i.test(name) || name === headGroup);

        subdivideParsed(parsed, subdivision, (face) => !isExcluded(face.group));
    }
    parsed._mtls = mtl;
    parsed._assetDir = assetDir;

    let rigType = null;
    let partMapping = {};
    let joints = {};
    let handleBoneMap = {};
    let offsetX = 0, offsetY = 0, offsetZ = 0;
    let rigData = null;

    const boxes = {};
    for (const g of parsed.groups) {
        boxes[g.name] = computeBox(g.vertexIndices, parsed.positions);
    }

    if (rig) {
        rigData = computeRig(parsed, {
            moreJoints,
            hint: readCachedRobloxType(assetDir),
            bendAccessories
        });

        rigType = rigData.rigType;
        partMapping = rigData.partMapping;
        handleBoneMap = rigData.handleBoneMap;

        offsetX = rigData.recenter.offsetX;
        offsetY = rigData.recenter.offsetY;
        offsetZ = rigData.recenter.offsetZ;

        // buildDocument works in recentered space.
        joints = {};
        for (const [name, p] of Object.entries(rigData.joints)) {
            joints[name] = [p[0] - offsetX, p[1] - offsetY, p[2] - offsetZ];
        }
    } else {
        // Split merged accessories even without a skeleton so each component
        // remains a separate exportable object.
        const playerGroups = parsed.groups.filter(
            (g) => /^Player\d+$/i.test(g.name)
        );
        const hint = readCachedRobloxType(assetDir);
        const resolvedRig = resolveRigType(parsed.groups, playerGroups.length, hint);

        if (resolvedRig.rigType) {
            const resolved = resolvePartMapping(
                parsed.groups,
                boxes,
                resolvedRig.rigType
            );
            const playerBoxes = {};
            for (const [part, groupName] of Object.entries(resolved.partMapping)) {
                playerBoxes[part] = boxes[groupName];
            }
            if (resolvedRig.rigType === "R6") {
                addR6HandBoxes(playerBoxes);
            }
            splitHandleGroups(parsed, playerBoxes);
        }

        // Non-rigged: center on the body only (accessories must not pull the
        // character off the origin) and put the feet at y = 0.
        const bodyGroups = parsed.groups.filter(
            (g) => !g.name.startsWith("Handle")
        );
        const groupsForBounds = bodyGroups.length ? bodyGroups : parsed.groups;

        const bodyVerts = [];
        for (const g of groupsForBounds) {
            for (const vi of g.vertexIndices) bodyVerts.push(vi);
        }

        const bodyBox = computeBox(bodyVerts, parsed.positions);
        offsetX = (bodyBox.xmin + bodyBox.xmax) / 2;
        offsetY = bodyBox.ymin;
        offsetZ = (bodyBox.zmin + bodyBox.zmax) / 2;
    }

    const { doc } = buildDocument(
        parsed,
        partMapping,
        joints,
        offsetX,
        offsetY,
        offsetZ,
        rigType,
        handleBoneMap,
        { splitParts, groupName, rigData: rig ? rigData : null }
    );

    return {
        doc,
        rigType,
        jointNames: rigType ? Object.keys(joints) : [],
        partMapping,
        groups: parsed.groups,
        boxes,
        positions: parsed.positions,
        normals: parsed.normals,
        uvs: parsed.uvs,
        vertexColors: parsed.vertexColors,
        faces: parsed.faces,
        mtl
    };
}

/**
 * Read the cached Roblox avatar type ("R6"/"R15") written to
 * downloads/<userId>/avatar.json at download time. Returns null when the file
 * is missing or malformed — callers treat that as "no hint".
 */
function readCachedRobloxType(assetDir) {
    try {
        const raw = fs.readFileSync(path.join(assetDir, "avatar.json"), "utf8");
        const data = JSON.parse(raw);
        return data && (data.playerAvatarType === "R6" || data.playerAvatarType === "R15")
            ? data.playerAvatarType
            : null;
    } catch {
        return null;
    }
}

/**
 * Lightweight part-mapping lookup (no GLB build).
 * Parses the OBJ, computes boxes, detects rig type, and matches body parts.
 * Returns group names, vertex counts, their mapped body-part names, plus a
 * compatibility report (matched vs expected parts).
 *
 * @param {string} assetDir
 * @returns {{ rigType: string|null, robloxType: string|null, compatibility: object, groups: Array<{name, vertices, faces, type, part}> }}
 */
function getPartInfo(assetDir, { moreJoints = false, hint = undefined } = {}) {
    const objPath = path.join(assetDir, "avatar.obj");
    if (!fs.existsSync(objPath)) {
        throw new Error("avatar.obj not found in " + assetDir);
    }

    // Resolve the Roblox type hint: explicit arg wins, else the cached
    // avatar.json written at download time.
    let resolvedHint = hint;
    let robloxType = hint || null;
    if (resolvedHint === undefined) {
        robloxType = readCachedRobloxType(assetDir);
        resolvedHint = robloxType;
    }

    const parsed = parseObj(objPath);

    const boxes = {};
    for (const g of parsed.groups) {
        boxes[g.name] = computeBox(g.vertexIndices, parsed.positions);
    }

    const playerGroups = parsed.groups.filter(g => g.name.startsWith("Player"));
    let handleGroups = parsed.groups.filter(g => g.name.startsWith("Handle"));

    const { rigType } = resolveRigType(parsed.groups, playerGroups.length, resolvedHint);

    let partMapping = {};
    let handleBoneMap = {};
    let extraGroupParts = {};

    if (rigType) {
        const resolved = resolvePartMapping(parsed.groups, boxes, rigType);
        partMapping = resolved.partMapping;
        extraGroupParts = resolved.extraGroupParts;

        const playerBoxes = {};
        for (const [part, gname] of Object.entries(partMapping)) {
            playerBoxes[part] = boxes[gname];
        }

        if (rigType === "R6") {
            addR6HandBoxes(playerBoxes);
        }

        if (splitHandleGroups(parsed, playerBoxes)) {
            handleGroups = parsed.groups.filter((g) => g.name.startsWith("Handle"));
        }

        for (const hg of handleGroups) {
            handleBoneMap[hg.name] = hg.splitPart
                || assignHandleBone(hg, playerBoxes, parsed.positions);
        }
    }

    const mappedGroupToPart = {};
    for (const [part, gname] of Object.entries(partMapping)) {
        mappedGroupToPart[gname] = part;
    }

    const groups = parsed.groups
        .filter(g => g.faceCount > 0)
        .map(g => {
            const mappedPart = mappedGroupToPart[g.name] || null;
            const handlePart = handleBoneMap[g.name] || null;
            const part = mappedPart || handlePart || null;
            const extraPart = extraGroupParts[g.name] || null;
            const type = g.name.startsWith("Player") || mappedPart
                ? "player"
                : g.name.startsWith("Handle") || handlePart
                    ? "handle"
                    : "other";
            return {
                name: g.name,
                baseName: g.baseName || g.name,
                vertices: g.vertexIndices.length,
                faces: g.faceCount,
                type,
                part,
                extraPart,
                segmentationConfidence: Number.isFinite(g.segmentationConfidence)
                    ? g.segmentationConfidence
                    : null
            };
        });

    // Bone hierarchy for the explorer's "Rig" section (matches a rigged export).
    let bones = null;
    if (rigType) {
        const joints = computeJoints(partMapping, boxes, 0, 0, 0, rigType, !!moreJoints);
        const { parentOf } = buildParentMap(rigType, joints);
        bones = Object.keys(joints).map((name) => ({
            name,
            parent: parentOf[name] || null
        }));
    }

    const compatibility = computeCompatibility(rigType, partMapping);
    const segmentedGroups = groups.filter((group) => group.segmentationConfidence !== null);

    return {
        rigType,
        robloxType,
        compatibility,
        groups,
        bones,
        segmentation: {
            groups: segmentedGroups.length,
            minConfidence: segmentedGroups.length
                ? Math.min(...segmentedGroups.map((group) => group.segmentationConfidence))
                : null
        }
    };
}

module.exports = {
    convertAvatar,
    getPartInfo,
    parseObj,
    parseObjString,
    parseMtl,
    readObjLimits,
    assertObjTextLimits,
    objLimitError,
    subdivideParsed,
    computeBox,
    detectRigType,
    detectNamedRigType,
    resolveRigType,
    computeCompatibility,
    readCachedRobloxType,
    mappingFromPartNames,
    resolvePartMapping,
    matchBodyParts,
    computeRecenter,
    computeJoints,
    assignHandleBone,
    weldedComponents,
    splitHandleGroups,
    addR6HandBoxes,
    createSkinner,
    buildParentMap,
    computeRig,
    findHeadGroupName
};