"use strict";

// Avatar converter with optional R6/R15 auto-rigging. Applies the fixes from
// the standalone prototype: UV V-flip for glTF, position+UV dedup, Uint8
// vertex colors, white baseColorFactor when textured, and feet recentered to y=0.

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
    const positions = [];
    const normals = [];
    const uvs = [];
    const vertexColors = [];
    const faces = [];

    let currentMaterial = "default";
    let currentGroup = null;

    const lines = fs.readFileSync(objPath, "utf8").split(/\r?\n/);
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
 * Levels are capped so an avatar cannot explode past ~2M faces.
 */
function subdivideParsed(parsed, levels) {
    let safeLevels = Math.max(0, Math.min(3, Math.floor(levels || 0)));

    while (
        safeLevels > 0 &&
        parsed.faces.length * Math.pow(4, safeLevels) > 2_000_000
    ) {
        safeLevels -= 1;
    }

    for (let level = 0; level < safeLevels; level++) {
        const nextFaces = [];

        for (const face of parsed.faces) {
            if (face.verts.length !== 3) {
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
    if (playerCount === 15) return "R15";
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
    const parts = {};
    const remaining = [...playerGroups];
    const isR15 = playerGroups.length === 15;

    // Head = highest box
    remaining.sort((a, b) => boxes[b.name].cy - boxes[a.name].cy);
    const headGroup = remaining.shift();
    parts.Head = headGroup.name;

    // Torso = groups near center, highest first
    const torsoCandidates = remaining.filter(g => Math.abs(boxes[g.name].cx) < 0.7);
    torsoCandidates.sort((a, b) => boxes[b.name].cy - boxes[a.name].cy);

    const torsoNames = [];
    if (torsoCandidates.length >= 1) {
        if (isR15) {
            parts.UpperTorso = torsoCandidates[0].name;
            torsoNames.push(torsoCandidates[0].name);
        } else {
            parts.Torso = torsoCandidates[0].name;
            torsoNames.push(torsoCandidates[0].name);
        }
    }
    if (isR15 && torsoCandidates.length >= 2) {
        parts.LowerTorso = torsoCandidates[1].name;
        torsoNames.push(torsoCandidates[1].name);
    }

    const torsoSet = new Set(torsoNames);
    const limbs = remaining.filter(g => !torsoSet.has(g.name));
    const armCandidates = limbs.filter(g => Math.abs(boxes[g.name].cx) > 1.0);
    const legCandidates = limbs.filter(g => Math.abs(boxes[g.name].cx) <= 1.0);

    const result = { ...parts };

    const assignSide = (candidateList, sidePrefix, sign, isArm) => {
        const sideLimbs = candidateList.filter(g => {
            const cx = boxes[g.name].cx;
            return sign === -1 ? cx < 0 : cx > 0;
        });
        sideLimbs.sort((a, b) => boxes[b.name].cy - boxes[a.name].cy);

        if (isR15) {
            if (isArm) {
                if (sideLimbs.length >= 1) result[sidePrefix + "UpperArm"] = sideLimbs[0].name;
                if (sideLimbs.length >= 2) result[sidePrefix + "LowerArm"] = sideLimbs[1].name;
                if (sideLimbs.length >= 3) result[sidePrefix + "Hand"] = sideLimbs[2].name;
            } else {
                if (sideLimbs.length >= 1) result[sidePrefix + "UpperLeg"] = sideLimbs[0].name;
                if (sideLimbs.length >= 2) result[sidePrefix + "LowerLeg"] = sideLimbs[1].name;
                if (sideLimbs.length >= 3) result[sidePrefix + "Foot"] = sideLimbs[2].name;
            }
        } else {
            if (isArm) {
                if (sideLimbs.length >= 1) result[sidePrefix + " Arm"] = sideLimbs[0].name;
            } else {
                if (sideLimbs.length >= 1) result[sidePrefix + " Leg"] = sideLimbs[0].name;
            }
        }
    };

    assignSide(armCandidates, "Left", -1, true);
    assignSide(armCandidates, "Right", 1, true);
    assignSide(legCandidates, "Left", -1, false);
    assignSide(legCandidates, "Right", 1, false);

    return result;
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
            // Waist pivot at the bottom of the torso so the upper body can bend
            // forward while the legs stay planted.
            J.Waist = sub([r6TorsoBox.cx, r6TorsoBox.ymin, r6TorsoBox.cz]);
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
                    J[`${side} LowerArm`] = sub([
                        r6Box.cx,
                        (r6Box.cy + r6Box.ymin) / 2,
                        r6Box.cz
                    ]);
                }
            } else if (moreJoints) {
                J[`${side} LowerLeg`] = sub([
                    r6Box.cx,
                    (r6Box.cy + r6Box.ymin) / 2,
                    r6Box.cz
                ]);
                J[`${side} Foot`] = sub(bottomCenter(r6Box));
            }
        } else if (upperBox || lowerBox || endBox) {
            if (upperBox) {
                const isArm = upperBox.cy > upperTorsoBox.cy - 0.5;
                const attachBox = isArm ? upperTorsoBox : lowerTorsoBox;
                const side = upperBox.cx < 0 ? 'left' : 'right';
                const attachX = side === 'left' ? attachBox.xmin : attachBox.xmax;
                const attachY = isArm ? attachBox.ymax : attachBox.ymin;
                J[upperName] = sub([attachX, attachY, attachBox.cz]);
            }
            if (upperBox && lowerBox) {
                const f = facingFace(upperBox, lowerBox);
                J[lowerName] = sub(facePoint(upperBox, f));
            }
            if (lowerBox && endBox) {
                const f = facingFace(lowerBox, endBox);
                J[endName] = sub(facePoint(lowerBox, f));
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
    if (/Leg|Foot/.test(bestPart)) {
        return hipsPart(rigType);
    }

    if (central && belowWaist && /Head|Arm|Hand/.test(bestPart)) {
        return hipsPart(rigType);
    }

    return bestPart;
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
    const rootName = rigType === "R6" ? "HumanoidRootPart" : "Root";

    const parentOf = {};
    if (rigType === "R6") {
        parentOf.Torso = joints.Waist ? "Waist" : rootName;
        parentOf.Waist = rootName;
        parentOf.Neck = "Torso";
        parentOf.Head = "Neck";
        parentOf["Left Arm"] = "Torso";
        parentOf["Right Arm"] = "Torso";
        parentOf["Left Hand"] = "Left Arm";
        parentOf["Right Hand"] = "Right Arm";
        parentOf["Left LowerArm"] = "Left Arm";
        parentOf["Right LowerArm"] = "Right Arm";
        parentOf["Left Leg"] = rootName;
        parentOf["Right Leg"] = rootName;
        parentOf["Left LowerLeg"] = "Left Leg";
        parentOf["Right LowerLeg"] = "Right Leg";
        parentOf["Left Foot"] = "Left LowerLeg";
        parentOf["Right Foot"] = "Right LowerLeg";
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
            if (armNode && handNode) {
                armNode.addChild(handNode);
            }

            const lowerArmNode = jointNodeMap[side + " LowerArm"];
            if (armNode && lowerArmNode) {
                armNode.addChild(lowerArmNode);
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
    const boneNameToIdx = {};
    jointNames.forEach((name, i) => { boneNameToIdx[name] = i; });

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
        const boneName = rigged
            ? (groupToPart[g.name] || handleBoneMap[g.name] || rootName)
            : null;
        const boneIdx = rigged && boneNameToIdx[boneName] !== undefined ? boneNameToIdx[boneName] : 0;

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
                        positions[vIdx * 3] - offsetX,
                        positions[vIdx * 3 + 1] - offsetY,
                        positions[vIdx * 3 + 2] - offsetZ
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
                        groupLocalJoints.push(boneIdx, 0, 0, 0);
                        groupLocalWeights.push(1.0, 0.0, 0.0, 0.0);
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

        allPos.push(...groupLocalPos);
        allNor.push(...groupLocalNor);
        allUv.push(...groupLocalUv);
        allCol.push(...groupLocalCol);
        if (rigged) {
            allJoints.push(...groupLocalJoints);
            allWeights.push(...groupLocalWeights);
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
            baseIndex: globalIndexOffset
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
            const jpos = joints[jointNames[i]];
            ibmData[i * 16 + 0] = 1; ibmData[i * 16 + 1] = 0; ibmData[i * 16 + 2] = 0; ibmData[i * 16 + 3] = 0;
            ibmData[i * 16 + 4] = 0; ibmData[i * 16 + 5] = 1; ibmData[i * 16 + 6] = 0; ibmData[i * 16 + 7] = 0;
            ibmData[i * 16 + 8] = 0; ibmData[i * 16 + 9] = 0; ibmData[i * 16 + 10] = 1; ibmData[i * 16 + 11] = 0;
            ibmData[i * 16 + 12] = -jpos[0]; ibmData[i * 16 + 13] = -jpos[1]; ibmData[i * 16 + 14] = -jpos[2]; ibmData[i * 16 + 15] = 1;
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

            if (rigged) {
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
            container.addChild(partNode);

            if (skin) {
                partNode.setSkin(skin);
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
        for (const p of matPrims) primIndices.push(...p.indices);

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
        subdivideParsed(parsed, subdivision);
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
        const playerGroups = parsed.groups.filter(g => g.name.startsWith("Player"));
        const handleGroups = parsed.groups.filter(g => g.name.startsWith("Handle"));

        rigType = detectRigType(playerGroups.length);
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
        offsetX = recenter.offsetX;
        offsetY = recenter.offsetY;
        offsetZ = recenter.offsetZ;

        joints = computeJoints(
            partMapping,
            boxes,
            offsetX,
            offsetY,
            offsetZ,
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

        for (const hg of handleGroups) {
            handleBoneMap[hg.name] = assignHandleBone(hg, playerBoxes, parsed.positions);
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
function getPartInfo(assetDir) {
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

    return { rigType, groups };
}

module.exports = {
    convertAvatar,
    getPartInfo,
    parseObj,
    parseMtl,
    subdivideParsed,
    computeBox,
    detectRigType,
    detectNamedRigType,
    mappingFromPartNames,
    matchBodyParts,
    computeRecenter,
    computeJoints,
    assignHandleBone
};