"use strict";

/**
 * Avatar converter with optional auto-rigging.
 *
 * Ports the standalone tools/auto-rig/rig.js prototype into a reusable module
 * with every fix applied during development:
 *   - UV V-flip for glTF convention (OBJ bottom-left -> glTF top-left)
 *   - Position+UV deduplication (merges duplicate vertices, shrinks file size)
 *   - Uint8 vertex colors (prevents dark tint that would multiply the texture)
 *   - White baseColorFactor when a texture exists (texture shows unmodified)
 *   - Feet recentered to y=0, x/z centered on the body
 *
 * When `rig` is true, additionally:
 *   - Detects R6 (6 Player groups) or R15 (15 Player groups)
 *   - Matches Player groups to body parts by POSITION (never group number)
 *   - Computes joints at articulation points (shoulders, hips, neck)
 *   - Assigns rigid 100%-to-one-bone weights
 *   - Builds a glTF skin (joints, inverseBindMatrices, JOINTS_0, WEIGHTS_0)
 *
 * Interface:
 *   convertAvatar(assetDir, { rig }) -> {
 *     doc, rigType, jointNames, partMapping, groups, boxes,
 *     positions, normals, uvs, vertexColors, faces, mtl
 *   }
 */

const fs = require("fs");
const path = require("path");
const { Document, Accessor } = require("@gltf-transform/core");

// ---------------------------------------------------------------------------
// OBJ / MTL parsing
// ---------------------------------------------------------------------------

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

function parseObj(objPath) {
    const positions = [];    // flat [x,y,z, x,y,z, ...]
    const normals = [];      // flat [x,y,z, ...]
    const uvs = [];          // flat [u,v, ...]
    const vertexColors = []; // flat [r,g,b,a, ...] (0-1)
    const faces = [];        // [{verts:[], norms:[], uvs:[], material: name}]

    let currentMaterial = "default";

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
            // Triangulate fan
            for (let i = 1; i < vertIdx.length - 1; i++) {
                faces.push({
                    verts: [vertIdx[0], vertIdx[i], vertIdx[i + 1]],
                    norms: [normIdx[0], normIdx[i], normIdx[i + 1]],
                    uvs: [uvIdx[0], uvIdx[i], uvIdx[i + 1]],
                    material: currentMaterial
                });
            }
        }
    }

    // Build groups: parse `g` lines in order and assign faces to groups
    const groupFaces = {}; // groupName -> array of face indices
    let activeGroup = null;
    let faceCounter = 0;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const parts = line.split(/\s+/);
        const tag = parts[0];
        if (tag === "g") {
            activeGroup = parts[1];
            if (!groupFaces[activeGroup]) groupFaces[activeGroup] = [];
        } else if (tag === "f") {
            if (activeGroup) {
                groupFaces[activeGroup].push(faceCounter);
            }
            faceCounter++;
        }
    }

    const groups = [];
    for (const gname of Object.keys(groupFaces)) {
        const vertSet = new Set();
        const faceIdxs = groupFaces[gname];
        for (const fi of faceIdxs) {
            const f = faces[fi];
            for (const vi of f.verts) vertSet.add(vi);
        }
        const vertIndices = Array.from(vertSet).sort((a, b) => a - b);
        const material = faces[faceIdxs[0]]?.material || "default";
        groups.push({
            name: gname,
            vertexIndices: vertIndices,
            faceIndices: faceIdxs,
            faceCount: faceIdxs.length,
            material: material
        });
    }

    return { positions, normals, uvs, vertexColors, groups, faces };
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

// ---------------------------------------------------------------------------
// Rig type detection
// ---------------------------------------------------------------------------

function detectRigType(playerCount) {
    if (playerCount === 6) return "R6";
    if (playerCount === 15) return "R15";
    return null;
}

// ---------------------------------------------------------------------------
// Body part matching by position
// ---------------------------------------------------------------------------

function matchBodyParts(playerGroups, boxes) {
    /**
     * Match Player groups to body parts by POSITION, never by group number.
     */
    const parts = {};
    const remaining = [...playerGroups];
    const isR15 = playerGroups.length === 15;

    // ---- Head: highest box ----
    remaining.sort((a, b) => boxes[b.name].cy - boxes[a.name].cy);
    const headGroup = remaining.shift();
    parts.Head = headGroup.name;

    // ---- Torso: |cx| small, sorted by cy descending ----
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

    // ---- Split limbs into arms vs legs by |cx| ----
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

// ---------------------------------------------------------------------------
// Recentering
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Joint computation
// ---------------------------------------------------------------------------

function computeJoints(partMapping, boxes, offsetX, offsetY, offsetZ, rigType) {
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

    // ---- Root joint ----
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

    // ---- Torso joints ----
    if (rigType === "R6") {
        if (partMapping.Torso) J.Torso = sub(center(get("Torso")));
    } else {
        if (partMapping.UpperTorso) J.UpperTorso = sub(center(get("UpperTorso")));
        if (partMapping.LowerTorso) J.LowerTorso = sub(center(get("LowerTorso")));
    }

    // ---- Head + Neck ----
    if (partMapping.Head) {
        J.Head = sub(center(get("Head")));
        const torsoForNeck = upperTorsoBox || r6TorsoBox || lowerTorsoBox;
        if (torsoForNeck) {
            J.Neck = sub([headBox.cx, headBox.ymin, headBox.cz]);
        }
    }

    // ---- Limb joints ----
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
            J[r6Name] = sub([attachX, attachY, r6TorsoBox.cz]);
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

// ---------------------------------------------------------------------------
// Weight assignment
// ---------------------------------------------------------------------------

function nearestPlayerPart(vertex, playerBoxes) {
    let bestName = null;
    let bestDist = Infinity;
    for (const [name, box] of Object.entries(playerBoxes)) {
        const dx = vertex[0] - box.cx;
        const dy = vertex[1] - box.cy;
        const dz = vertex[2] - box.cz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestDist) {
            bestDist = d;
            bestName = name;
        }
    }
    return bestName;
}

function assignHandleBone(handleGroup, playerBoxes, positions) {
    const votes = {};
    for (const vi of handleGroup.vertexIndices) {
        const v = [
            positions[vi * 3],
            positions[vi * 3 + 1],
            positions[vi * 3 + 2]
        ];
        const part = nearestPlayerPart(v, playerBoxes);
        votes[part] = (votes[part] || 0) + 1;
    }
    let bestPart = null;
    let bestVotes = -1;
    for (const [part, count] of Object.entries(votes)) {
        if (count > bestVotes) {
            bestVotes = count;
            bestPart = part;
        }
    }
    return bestPart;
}

// ---------------------------------------------------------------------------
// GLB building
// ---------------------------------------------------------------------------

function createAccessor(doc, buffer, array, typeStr, componentType, normalized = false) {
    const acc = doc.createAccessor();
    acc.setType(typeStr);
    acc.set("componentType", componentType);
    acc.setArray(array);
    acc.setNormalized(normalized);
    acc.setBuffer(buffer);
    return acc;
}

function buildDocument(parsed, partMapping, joints, offsetX, offsetY, offsetZ, rigType, handleBoneMap) {
    const { positions, normals, uvs, vertexColors, groups, faces } = parsed;
    const rigged = !!rigType;

    const doc = new Document();
    const root = doc.getRoot();
    const scene = doc.createScene("Scene");
    const buffer = doc.createBuffer();

    // ---- Materials ----
    const materialMap = {};
    for (const g of groups) {
        const matName = g.material;
        if (materialMap[matName]) continue;

        const mtl = parsed._mtls[matName] || { Kd: [0.8, 0.8, 0.8], map_Kd: null };
        const mat = doc.createMaterial(matName);

        if (mtl.map_Kd) {
            const texPath = path.join(parsed._assetDir, mtl.map_Kd);
            if (fs.existsSync(texPath)) {
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

    // ---- Joint nodes ----
    const jointNodeMap = {};
    const jointNames = rigged ? Object.keys(joints) : [];
    const rootName = rigType === "R6" ? "HumanoidRootPart" : "Root";

    const parentOf = {};
    if (rigType === "R6") {
        parentOf.Torso = rootName;
        parentOf.Neck = "Torso";
        parentOf.Head = "Neck";
        parentOf["Left Arm"] = "Torso";
        parentOf["Right Arm"] = "Torso";
        parentOf["Left Leg"] = rootName;
        parentOf["Right Leg"] = rootName;
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
        scene.addChild(rootNode);
    }

    // Invert partMapping: groupName -> partName (bone name)
    const groupToPart = {};
    for (const [part, gname] of Object.entries(partMapping)) {
        groupToPart[gname] = part;
    }

    // Hierarchy
    if (rigged && rigType === "R6") {
        const torsoNode = jointNodeMap["Torso"];
        if (torsoNode) rootNode.addChild(torsoNode);
        if (jointNodeMap["Neck"] && jointNodeMap["Head"]) {
            torsoNode.addChild(jointNodeMap["Neck"]);
            jointNodeMap["Neck"].addChild(jointNodeMap["Head"]);
        }
        for (const side of ["Left", "Right"]) {
            const armNode = jointNodeMap[side + " Arm"];
            if (torsoNode && armNode) torsoNode.addChild(armNode);
        }
        for (const side of ["Left", "Right"]) {
            const legNode = jointNodeMap[side + " Leg"];
            if (rootNode && legNode) rootNode.addChild(legNode);
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

    // ---- Meshes ----
    const boneNameToIdx = {};
    jointNames.forEach((name, i) => { boneNameToIdx[name] = i; });

    const allPos = [];
    const allNor = [];
    const allUv = [];
    const allCol = [];
    const allJoints = [];
    const allWeights = [];
    const primInfos = [];

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
                const key = `${px}|${py}|${pz}|${u}|${v}`;

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
                const key = `${px}|${py}|${pz}|${u}|${v}`;
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

        primInfos.push({
            material: g.material,
            startIndex: globalIndexOffset,
            indexCount: groupIndices.length,
            indices: groupIndices
        });

        globalIndexOffset += groupLocalPos.length / 3;
    }

    // Create single merged mesh
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
            .setMode(4) // TRIANGLES
            .setAttribute("POSITION", createAccessor(doc, buffer, new Float32Array(allPos), "VEC3", Accessor.ComponentType.FLOAT))
            .setAttribute("NORMAL", createAccessor(doc, buffer, new Float32Array(allNor), "VEC3", Accessor.ComponentType.FLOAT))
            .setAttribute("TEXCOORD_0", createAccessor(doc, buffer, new Float32Array(allUv), "VEC2", Accessor.ComponentType.FLOAT))
            .setAttribute("COLOR_0", createAccessor(doc, buffer, colorBytes, "VEC4", Accessor.ComponentType.UNSIGNED_BYTE, true));

        if (rigged) {
            prim.setAttribute("JOINTS_0", createAccessor(doc, buffer, new Uint16Array(allJoints), "VEC4", Accessor.ComponentType.UNSIGNED_SHORT));
            prim.setAttribute("WEIGHTS_0", createAccessor(doc, buffer, new Float32Array(allWeights), "VEC4", Accessor.ComponentType.FLOAT));
        }

        prim.setIndices(createAccessor(doc, buffer, new Uint16Array(primIndices), "SCALAR", Accessor.ComponentType.UNSIGNED_SHORT))
            .setMaterial(materialMap[matName] || materialMap["default"] || null);

        mesh.addPrimitive(prim);
    }

    const meshNode = doc.createNode("character_mesh");
    meshNode.setMesh(mesh);
    scene.addChild(meshNode);

    // ---- Skin ----
    if (rigged) {
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

        meshNode.setSkin(skin);
    }

    return { doc, root, scene, buffer };
}

// ---------------------------------------------------------------------------
// Main conversion
// ---------------------------------------------------------------------------

/**
 * Convert a downloaded avatar (OBJ + MTL + textures) into a glTF document.
 *
 * @param {string} assetDir - directory containing avatar.obj / avatar.mtl / textures
 * @param {object} options
 * @param {boolean} options.rig - add R6/R15 skeleton and skinning
 * @returns {Promise<object>} { doc, rigType, jointNames, partMapping, groups, boxes, positions, normals, uvs, vertexColors, faces, mtl }
 */
async function convertAvatar(assetDir, { rig = false } = {}) {
    const objPath = path.join(assetDir, "avatar.obj");
    if (!fs.existsSync(objPath)) {
        throw new Error("avatar.obj not found in " + assetDir);
    }

    const mtl = parseMtl(path.join(assetDir, "avatar.mtl"));
    const parsed = parseObj(objPath);
    parsed._mtls = mtl;
    parsed._assetDir = assetDir;

    let rigType = null;
    let partMapping = {};
    let joints = {};
    let handleBoneMap = {};
    let offsetX = 0, offsetY = 0, offsetZ = 0;

    // Compute boxes for all groups (needed for both rigged and non-rigged recentering)
    const boxes = {};
    for (const g of parsed.groups) {
        boxes[g.name] = computeBox(g.vertexIndices, parsed.positions);
    }

    if (rig) {
        const playerGroups = parsed.groups.filter(g => g.name.startsWith("Player"));
        const handleGroups = parsed.groups.filter(g => g.name.startsWith("Handle"));

        rigType = detectRigType(playerGroups.length);
        if (!rigType) {
            throw new Error(
                `Auto-rig requires 6 (R6) or 15 (R15) Player groups, found ${playerGroups.length}`
            );
        }

        partMapping = matchBodyParts(playerGroups, boxes);
        const recenter = computeRecenter(boxes, partMapping);
        offsetX = recenter.offsetX;
        offsetY = recenter.offsetY;
        offsetZ = recenter.offsetZ;

        joints = computeJoints(partMapping, boxes, offsetX, offsetY, offsetZ, rigType);

        const playerBoxes = {};
        for (const [part, gname] of Object.entries(partMapping)) {
            playerBoxes[part] = boxes[gname];
        }
        for (const hg of handleGroups) {
            handleBoneMap[hg.name] = assignHandleBone(hg, playerBoxes, parsed.positions);
        }
    } else {
        // Non-rigged: recenter on the whole model so feet sit at y=0 and x/z are centered.
        const allVerts = [];
        for (const g of parsed.groups) {
            for (const vi of g.vertexIndices) allVerts.push(vi);
        }
        const allBoxes = { all: computeBox(allVerts, parsed.positions) };
        const recenter = computeRecenter(allBoxes, { all: "all" });
        offsetX = recenter.offsetX;
        offsetY = recenter.offsetY;
        offsetZ = recenter.offsetZ;
    }

    const { doc } = buildDocument(parsed, partMapping, joints, offsetX, offsetY, offsetZ, rigType, handleBoneMap);

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
    const rigType = detectRigType(playerGroups.length);

    let partMapping = {};
    let handleBoneMap = {};

    if (rigType) {
        partMapping = matchBodyParts(playerGroups, boxes);
        const playerBoxes = {};
        for (const [part, gname] of Object.entries(partMapping)) {
            playerBoxes[part] = boxes[gname];
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
            const type = g.name.startsWith("Player")
                ? "player"
                : g.name.startsWith("Handle")
                    ? "handle"
                    : "other";
            const part = groupToPart[g.name] || handleBoneMap[g.name] || null;
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
    computeBox,
    detectRigType,
    matchBodyParts,
    computeRecenter,
    computeJoints,
    assignHandleBone
};