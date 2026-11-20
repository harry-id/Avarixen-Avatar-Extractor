"use strict";

const fs = require("fs");
const path = require("path");
const { Document, Accessor } = require("@gltf-transform/core");

function parseMtl(mtlPath) {
    const materials = {};
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
                map_Kd: null
            };
        } else if (current && tag === "Kd") {
            materials[current].Kd = [+parts[1], +parts[2], +parts[3]];
        } else if (current && (tag === "map_Kd" || tag === "map_kd")) {
            materials[current].map_Kd = parts.slice(1).join(" ") || null;
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

function parseObj(objPath) {
    return parseObjString(fs.readFileSync(objPath, "utf8"));
}

function parseObjString(text) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const vertexColors = [];
    const faces = [];

    let currentMaterial = "default";
    let currentGroup = null;

    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const parts = line.split(/\s+/);
        const tag = parts[0];

        if (tag === "v") {
            positions.push(+parts[1], +parts[2], +parts[3]);
            if (parts.length >= 7) {
                vertexColors.push(+parts[4], +parts[5], +parts[6], parts.length >= 8 ? +parts[7] : 1.0);
            } else {
                vertexColors.push(1, 1, 1, 1);
            }
        } else if (tag === "vn") {
            normals.push(+parts[1], +parts[2], +parts[3]);
        } else if (tag === "vt") {
            uvs.push(+parts[1], +parts[2]);
        } else if (tag === "usemtl") {
            currentMaterial = parts.slice(1).join(" ") || "default";
        } else if (tag === "g") {
            currentGroup = parts.slice(1).join(" ") || null;
        } else if (tag === "f") {
            const vertIdx = [];
            const normIdx = [];
            const uvIdx = [];
            for (let i = 1; i < parts.length; i++) {
                const [v, t, n] = parts[i].split("/");
                vertIdx.push(v ? +v - 1 : -1);
                uvIdx.push(t ? +t - 1 : -1);
                normIdx.push(n ? +n - 1 : -1);
            }
            for (let i = 1; i < vertIdx.length - 1; i++) {
                faces.push({
                    verts: [vertIdx[0], vertIdx[i], vertIdx[i + 1]],
                    norms: [normIdx[0], normIdx[i], normIdx[i + 1]],
                    uvs: [uvIdx[0], uvIdx[i], uvIdx[i + 1]],
                    material: currentMaterial,
                    group: currentGroup
                });
            }
        }
    }

    return { positions, normals, uvs, vertexColors, groups: rebuildGroups(faces), faces };
}

function rebuildGroups(faces) {
    const map = new Map();

    faces.forEach((face, index) => {
        if (!face.group) {
            return;
        }

        let entry = map.get(face.group);

        if (!entry) {
            entry = {
                name: face.group,
                faceIndices: [],
                vertices: new Set()
            };
            map.set(face.group, entry);
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

            const midpoint = (c1, c2) => {
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

                return { p: pIdx, n: nIdx, t: tIdx };
            };

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

    if (R6_PART_NAMES.every((name) => names.has(normalizePartName(name)))) {
        return "R6";
    }

    if (R15_PART_NAMES.every((name) => names.has(normalizePartName(name)))) {
        return "R15";
    }

    return null;
}

// Map each rig part (Head, Left Arm, ...) to the actual group name in the OBJ,
// which may be written as LeftArm to avoid OBJ's whitespace-separated groups.
function mappingFromPartNames(rigType, groups) {
    const partNames = rigType === "R6" ? R6_PART_NAMES : R15_PART_NAMES;
    const groupByNormalized = new Map(
        groups.map((group) => [normalizePartName(group.name), group.name])
    );
    const mapping = {};

    for (const name of partNames) {
        mapping[name] = groupByNormalized.get(normalizePartName(name)) || name;
    }

    return mapping;
}

function matchBodyParts(playerGroups, boxes) {
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
    // even when a part is missing.
    const isR15 = playerGroups.length > 6;

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

function assignHandleBone(handleGroup, playerBoxes, positions) {
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
        if (/Leg|Foot/.test(part)) {
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
    if (/Leg|Foot/.test(bestPart)) {
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

// --- Minimal quaternion helpers for orienting GLB joints ---
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

function buildDocument(parsed, partMapping, joints, offsetX, offsetY, offsetZ, rigType, handleBoneMap, options = {}) {
    const splitParts = !!options.splitParts;
    const groupName = options.groupName || "Avatar";
    const { positions, normals, uvs, vertexColors, groups, faces } = parsed;
    const rigged = !!rigType;

    const doc = new Document();
    const root = doc.getRoot();
    const scene = doc.createScene("Scene");
    const buffer = doc.createBuffer();
    const materialMap = {};
    for (const g of groups) {
        const matName = g.material;
        if (materialMap[matName]) continue;

        const mtl = parsed._mtls[matName] || { Kd: [0.8, 0.8, 0.8], map_Kd: null };
        const mat = doc.createMaterial(matName);

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
            mat.setBaseColorFactor([1, 1, 1, 1]);
        } else {
            mat.setBaseColorFactor([...mtl.Kd, 1.0]);
        }
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

    const groupToPart = {};
    for (const [part, gname] of Object.entries(partMapping)) {
        groupToPart[gname] = part;
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

    const allPos = [];
    const allNor = [];
    const allUv = [];
    const allCol = [];
    const allJoints = [];
    const allWeights = [];
    const primInfos = [];
    const groupBuilds = [];

    let globalIndexOffset = 0;

    for (const g of groups) {
        // Handles are parented to a bone as rigid child nodes (not skinned) so
        // they stay separate, movable objects; unparented ones stay centered.
        const isHandle = Object.prototype.hasOwnProperty.call(handleBoneMap, g.name);
        const assignedBone = isHandle ? handleBoneMap[g.name] : null;

        const boneName = rigged
            ? (groupToPart[g.name] || assignedBone || rootName)
            : null;
        const boneIdx = rigged && boneNameToIdx[boneName] !== undefined ? boneNameToIdx[boneName] : 0;
        const limbSkin = (rigged && !isHandle) ? limbSkinFor(boneName) : null;

        // Center accessory geometry on its own pivot; the assembly node
        // translation restores the original world position.
        let handleCenter = null;
        if (isHandle && splitParts) {
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

        for (const fi of faceIndices) {
            const f = faces[fi];
            for (let ci = 0; ci < f.verts.length; ci++) {
                const vIdx = f.verts[ci];
                const uIdx = f.uvs[ci] !== undefined ? f.uvs[ci] : -1;
                const nIdx = f.norms[ci] !== undefined ? f.norms[ci] : -1;

                // Dedup by recentered position + UV (merges duplicate vertices)
                const px = (positions[vIdx * 3] - offsetX).toFixed(4);
                const py = (positions[vIdx * 3 + 1] - offsetY).toFixed(4);
                const pz = (positions[vIdx * 3 + 2] - offsetZ).toFixed(4);
                const u = uIdx >= 0 && uvs.length > uIdx * 2 ? uvs[uIdx * 2].toFixed(4) : '0';
                const v = uIdx >= 0 && uvs.length > uIdx * 2 ? (1.0 - uvs[uIdx * 2 + 1]).toFixed(4) : '0';
                const key = `${px}|${py}|${pz}|${u}|${v}|${nIdx}`;

                let localIdx;
                if (cornerMap[key] !== undefined) {
                    localIdx = cornerMap[key];
                } else {
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
                        if (limbSkin) {
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
            }
        }

        const groupIndices = [];
        for (const fi of faceIndices) {
            const f = faces[fi];
            for (let ci = 0; ci < f.verts.length; ci++) {
                const vIdx = f.verts[ci];
                const uIdx = f.uvs[ci] !== undefined ? f.uvs[ci] : -1;
                const nIdx = f.norms[ci] !== undefined ? f.norms[ci] : -1;

                const px = (positions[vIdx * 3] - offsetX).toFixed(4);
                const py = (positions[vIdx * 3 + 1] - offsetY).toFixed(4);
                const pz = (positions[vIdx * 3 + 2] - offsetZ).toFixed(4);
                const u = uIdx >= 0 && uvs.length > uIdx * 2 ? uvs[uIdx * 2].toFixed(4) : '0';
                const v = uIdx >= 0 && uvs.length > uIdx * 2 ? (1.0 - uvs[uIdx * 2 + 1]).toFixed(4) : '0';
                const key = `${px}|${py}|${pz}|${u}|${v}|${nIdx}`;
                groupIndices.push(globalIndexOffset + cornerMap[key]);
            }
        }

        pushAll(allPos, groupLocalPos);
        pushAll(allNor, groupLocalNor);
        pushAll(allUv, groupLocalUv);
        pushAll(allCol, groupLocalCol);
        if (rigged) {
            pushAll(allJoints, groupLocalJoints);
            pushAll(allWeights, groupLocalWeights);
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
            handleCenter,
            boneName: isHandle ? assignedBone : null
        });

        primInfos.push({
            material: g.material,
            startIndex: globalIndexOffset,
            indexCount: groupIndices.length,
            indices: groupIndices
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

            if (rigged && !build.isHandle) {
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

            if (build.isHandle && build.handleCenter) {
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

    const mesh = doc.createMesh("character_mesh");

    // Convert float colors (0-1) to Uint8 (0-255) for UNSIGNED_BYTE normalized accessor.
    const colorBytes = new Uint8Array(allCol.length);
    for (let i = 0; i < allCol.length; i++) {
        colorBytes[i] = Math.max(0, Math.min(255, Math.round(allCol[i] * 255)));
    }

    const materialsUsed = [...new Set(primInfos.map(p => p.material))];
    for (const matName of materialsUsed) {
        const matPrims = primInfos.filter(p => p.material === matName);
        const primIndices = [];
        for (const p of matPrims) {
            pushAll(primIndices, p.indices);
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
function computeRig(parsed, { moreJoints = false } = {}) {
    const boxes = {};
    for (const g of parsed.groups) {
        boxes[g.name] = computeBox(g.vertexIndices, parsed.positions);
    }

    const playerGroups = parsed.groups.filter((g) => g.name.startsWith("Player"));
    const handleGroups = parsed.groups.filter((g) => g.name.startsWith("Handle"));

    let rigType = detectRigType(playerGroups.length);
    let partMapping = {};

    if (rigType) {
        partMapping = matchBodyParts(playerGroups, boxes);
    } else {
        // Exported avatars are renamed (Head, Torso, ...), so fall back to
        // detecting the rig from those part names.
        rigType = detectNamedRigType(parsed.groups);

        if (rigType) {
            partMapping = mappingFromPartNames(rigType, parsed.groups);
        }
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

    const handleBoneMap = {};
    for (const hg of handleGroups) {
        handleBoneMap[hg.name] = assignHandleBone(hg, playerBoxes, parsed.positions);
    }

    const groupToPart = {};
    for (const [part, gname] of Object.entries(partMapping)) {
        groupToPart[gname] = part;
    }

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

    return {
        rigType,
        partMapping,
        recenter,
        joints,
        parentOf,
        rootName,
        groupToPart,
        handleBoneMap,
        boneNameToIdx,
        skinFor
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
    moreJoints = false
} = {}) {
    const objPath = path.join(assetDir, "avatar.obj");
    if (!fs.existsSync(objPath)) {
        throw new Error("avatar.obj not found in " + assetDir);
    }

    const mtl = parseMtl(path.join(assetDir, "avatar.mtl"));
    const parsed = parseObj(objPath);

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

    const boxes = {};
    for (const g of parsed.groups) {
        boxes[g.name] = computeBox(g.vertexIndices, parsed.positions);
    }

    if (rig) {
        const rigData = computeRig(parsed, { moreJoints });

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
        { splitParts, groupName }
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
 * Lightweight part-mapping lookup (no GLB build).
 * Parses the OBJ, computes boxes, detects rig type, and matches body parts.
 * Returns group names, vertex counts, and their mapped body-part names.
 *
 * @param {string} assetDir
 * @returns {{ rigType: string|null, groups: Array<{name, vertices, faces, type, part}> }}
 */
function getPartInfo(assetDir, { moreJoints = false } = {}) {
    const objPath = path.join(assetDir, "avatar.obj");
    if (!fs.existsSync(objPath)) {
        throw new Error("avatar.obj not found in " + assetDir);
    }

    const parsed = parseObj(objPath);

    const boxes = {};
    for (const g of parsed.groups) {
        boxes[g.name] = computeBox(g.vertexIndices, parsed.positions);
    }

    const playerGroups = parsed.groups.filter(g => g.name.startsWith("Player"));
    const handleGroups = parsed.groups.filter(g => g.name.startsWith("Handle"));

    const rigType = detectRigType(playerGroups.length) || detectNamedRigType(parsed.groups);

    let partMapping = {};
    let handleBoneMap = {};

    if (rigType) {
        partMapping = detectRigType(playerGroups.length)
            ? matchBodyParts(playerGroups, boxes)
            : mappingFromPartNames(rigType, parsed.groups);

        const playerBoxes = {};
        for (const [part, gname] of Object.entries(partMapping)) {
            playerBoxes[part] = boxes[gname];
        }

        if (rigType === "R6") {
            addR6HandBoxes(playerBoxes);
        }

        for (const hg of handleGroups) {
            handleBoneMap[hg.name] = assignHandleBone(hg, playerBoxes, parsed.positions);
        }
    }

    const groupToPart = {};
    for (const [part, gname] of Object.entries(partMapping)) {
        groupToPart[gname] = part;
    }

    const groups = parsed.groups
        .filter(g => g.faceCount > 0)
        .map(g => {
            const part = groupToPart[g.name] || handleBoneMap[g.name] || null;
            const type = g.name.startsWith("Player") || groupToPart[g.name]
                ? "player"
                : g.name.startsWith("Handle")
                    ? "handle"
                    : "other";
            return {
                name: g.name,
                vertices: g.vertexIndices.length,
                faces: g.faceCount,
                type,
                part
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

    return { rigType, groups, bones };
}

module.exports = {
    convertAvatar,
    getPartInfo,
    parseObj,
    parseObjString,
    parseMtl,
    subdivideParsed,
    computeBox,
    detectRigType,
    detectNamedRigType,
    mappingFromPartNames,
    matchBodyParts,
    computeRecenter,
    computeJoints,
    assignHandleBone,
    addR6HandBoxes,
    createSkinner,
    buildParentMap,
    computeRig,
    findHeadGroupName
};