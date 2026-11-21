"use strict";

// Binary FBX 7.4 exporter. Builds a Three.js scene from the avatar OBJ/MTL and
// serializes it with @comfyorg/fbx-exporter-three. The output is a genuine
// binary .fbx ("Kaydara FBX Binary") that Blender, Unity, Unreal, F3D and other
// importers accept, unlike ASCII FBX which many tools reject.

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { isBodyGroup } = require("./obj-utils");
const { computeRig, parseObjString, readCachedRobloxType } = require("./auto-rig");

let THREE = null;
let FBXExporter = null;

async function ensureModules() {
    if (!THREE) {
        const threeMod = await import("three");
        THREE = threeMod;
        const fbxMod = await import("@comfyorg/fbx-exporter-three");
        FBXExporter = fbxMod.FBXExporter;
    }
    return { THREE, FBXExporter };
}

function parseObj(text) {
    const positions = [];
    const normals = [];
    const uvs = [];
    const polygons = [];
    let currentMaterial = null;
    let currentGroup = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith("#")) {
            continue;
        }

        const parts = line.split(/\s+/);
        const tag = parts[0];

        if (tag === "v") {
            positions.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
        } else if (tag === "vn") {
            normals.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
        } else if (tag === "vt") {
            uvs.push([Number(parts[1]), Number(parts[2])]);
        } else if (tag === "usemtl") {
            currentMaterial = parts.slice(1).join(" ") || null;
        } else if (tag === "g") {
            currentGroup = parts.slice(1).join(" ") || null;
        } else if (tag === "f") {
            const corners = [];

            for (let i = 1; i < parts.length; i++) {
                const [vp, vt, vn] = parts[i].split("/");

                corners.push({
                    p: vp ? Number(vp) - 1 : null,
                    t: vt ? Number(vt) - 1 : null,
                    n: vn ? Number(vn) - 1 : null
                });
            }

            if (corners.length >= 3 && corners.every((corner) => corner.p !== null)) {
                polygons.push({ corners, material: currentMaterial, group: currentGroup });
            }
        }
    }

    return { positions, normals, uvs, polygons };
}

function parseMtl(text) {
    const materials = new Map();
    let current = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith("#")) {
            continue;
        }

        const parts = line.split(/\s+/);
        const tag = parts[0];

        if (tag === "newmtl") {
            current = {
                name: parts.slice(1).join(" ") || "material",
                Kd: [0.8, 0.8, 0.8],
                map_Kd: null
            };
            materials.set(current.name, current);
        } else if (current && tag === "Kd") {
            current.Kd = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
        } else if (current && (tag === "map_Kd" || tag === "map_kd")) {
            current.map_Kd = parts.slice(1).join(" ") || null;
        }
    }

    return materials;
}

function resolveTexture(assetDir, filename) {
    if (!filename) {
        return null;
    }

    const resolved = path.resolve(assetDir, filename);
    const root = path.resolve(assetDir);

    // Never read outside the downloaded avatar folder.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return null;
    }

    return resolved;
}

async function loadTexture(assetDir, filename) {
    const resolved = resolveTexture(assetDir, filename);

    if (!resolved) {
        return null;
    }

    try {
        const buf = fs.readFileSync(resolved);
        const png = PNG.sync.read(buf);

        const texture = new THREE.DataTexture(
            new Uint8ClampedArray(png.data),
            png.width,
            png.height,
            THREE.RGBAFormat
        );
        // The FBX exporter uses the texture name as the external file name
        // when embedTextures is false.
        texture.name = path.basename(filename).replace(/\.[^.]+$/, "");

        return texture;
    } catch {
        return null;
    }
}

function createBounds() {
    return {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
        found: false
    };
}

function extendBounds(bounds, x, y, z) {
    bounds.found = true;
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (z < bounds.minZ) bounds.minZ = z;
    if (z > bounds.maxZ) bounds.maxZ = z;
}

async function buildFbx({
    objText,
    mtlText,
    assetDir,
    splitParts = false,
    groupName = "Avatar",
    embedTextures = true,
    subdivision = 0,
    excludeSubdivision = [],
    rig = false,
    moreJoints = false,
    bendAccessories = false
}) {
    const { THREE: T, FBXExporter } = await ensureModules();

    const obj = parseObj(objText);
    const mtl = mtlText ? parseMtl(mtlText) : new Map();
    const excludeSubdivisionSet = new Set(excludeSubdivision || []);

    if (obj.polygons.length === 0) {
        throw new Error("FBX conversion failed: the OBJ has no faces.");
    }

    // Build the same R6/R15 skeleton the GLB exporter uses. `skinFor` returns
    // bone indices/weights from raw OBJ positions, so it is independent of the
    // axis/offset conversion applied below.
    const rigData = rig
        ? computeRig(parseObjString(objText), {
            moreJoints,
            hint: readCachedRobloxType(assetDir),
            bendAccessories
        })
        : null;

    // Match the GLB export: center the body on X/Z and put the feet at y = 0.
    let safeSubdivision = Math.max(0, Math.min(4, Math.floor(subdivision || 0)));

    const baseTriangleCount = obj.polygons.reduce(
        (sum, poly) => sum + Math.max(1, poly.corners.length - 2),
        0
    );

    while (
        safeSubdivision > 0 &&
        baseTriangleCount * Math.pow(4, safeSubdivision) > 3_500_000
    ) {
        safeSubdivision -= 1;
    }

    const all = createBounds();
    const body = createBounds();

    for (const poly of obj.polygons) {
        const isBody = isBodyGroup(poly.group || "");

        for (const corner of poly.corners) {
            const pos = obj.positions[corner.p];

            if (!pos) {
                continue;
            }

            extendBounds(all, pos[0], pos[1], pos[2]);
            if (isBody) {
                extendBounds(body, pos[0], pos[1], pos[2]);
            }
        }
    }

    const src = body.found ? body : all;
    const offsetX = (src.minX + src.maxX) / 2;
    const offsetY = src.minY;
    const offsetZ = (src.minZ + src.maxZ) / 2;

    const matNames = [...new Set(obj.polygons.map((poly) => poly.material || "default"))];

    const texMap = new Map();
    for (const name of matNames) {
        const material = mtl.get(name);

        if (material?.map_Kd) {
            const texture = await loadTexture(assetDir, material.map_Kd);

            if (texture) {
                texMap.set(name, texture);
            }
        }
    }

    const materialCache = new Map();
    const materialFor = (name) => {
        if (!materialCache.has(name)) {
            const material = mtl.get(name) || { Kd: [0.8, 0.8, 0.8] };
            materialCache.set(name, new T.MeshPhongMaterial({
                color: new T.Color(material.Kd[0], material.Kd[1], material.Kd[2]),
                map: texMap.get(name) || undefined
            }));
        }

        return materialCache.get(name);
    };

    const buildPart = (polys, fixedGroupName = null, recenter = null, skinFn = null) => {
        const usedNames = [...new Set(polys.map((poly) => poly.material || "default"))];
        const nameToIndex = new Map(usedNames.map((name, i) => [name, i]));

        const positions = [];
        const normals = [];
        const uvs = [];
        const indices = [];
        const groupCounts = {};
        const skinIndices = [];
        const skinWeights = [];

        let vertexIndex = 0;

        const cornerData = (poly, cornerIndex) => {
            const idx = poly.corners[cornerIndex];
            const pos = obj.positions[idx.p];

            let n = [0, 1, 0];
            if (idx.n !== null && obj.normals[idx.n]) {
                n = obj.normals[idx.n];
            }

            let uv = [0, 0];
            if (idx.t !== null && obj.uvs[idx.t]) {
                uv = [obj.uvs[idx.t][0], 1 - obj.uvs[idx.t][1]];
            }

            return {
                p: [
                    -(pos[0] - offsetX),
                    pos[1] - offsetY,
                    -(pos[2] - offsetZ)
                ],
                n: [-n[0], n[1], -n[2]],
                t: uv,
                // Raw OBJ position, used for skin-weight evaluation.
                raw: [pos[0], pos[1], pos[2]]
            };
        };

        const midpoint = (c1, c2) => {
            const n = [
                (c1.n[0] + c2.n[0]) / 2,
                (c1.n[1] + c2.n[1]) / 2,
                (c1.n[2] + c2.n[2]) / 2
            ];
            const length = Math.hypot(n[0], n[1], n[2]);

            return {
                p: [
                    (c1.p[0] + c2.p[0]) / 2,
                    (c1.p[1] + c2.p[1]) / 2,
                    (c1.p[2] + c2.p[2]) / 2
                ],
                n: length > 0
                    ? [n[0] / length, n[1] / length, n[2] / length]
                    : [0, 1, 0],
                t: [
                    (c1.t[0] + c2.t[0]) / 2,
                    (c1.t[1] + c2.t[1]) / 2
                ],
                raw: [
                    (c1.raw[0] + c2.raw[0]) / 2,
                    (c1.raw[1] + c2.raw[1]) / 2,
                    (c1.raw[2] + c2.raw[2]) / 2
                ]
            };
        };

        const emitTriangle = (c1, c2, c3, mi, level, groupName) => {
            if (level === 0) {
                groupCounts[mi] = (groupCounts[mi] || 0) + 3;

                for (const c of [c1, c2, c3]) {
                    positions.push(
                        c.p[0] - (recenter ? recenter.x : 0),
                        c.p[1] - (recenter ? recenter.y : 0),
                        c.p[2] - (recenter ? recenter.z : 0)
                    );
                    normals.push(c.n[0], c.n[1], c.n[2]);
                    uvs.push(c.t[0], c.t[1]);

                    if (rigData && !recenter) {
                        const skin = (skinFn || rigData.skinFor)(groupName, c.raw[0], c.raw[1], c.raw[2]);
                        skinIndices.push(
                            skin.indices[0], skin.indices[1],
                            skin.indices[2], skin.indices[3]
                        );
                        skinWeights.push(
                            skin.weights[0], skin.weights[1],
                            skin.weights[2], skin.weights[3]
                        );
                    }

                    indices.push(vertexIndex++);
                }

                return;
            }

            const a = midpoint(c1, c2);
            const b = midpoint(c2, c3);
            const c = midpoint(c3, c1);

            emitTriangle(c1, a, c, mi, level - 1, groupName);
            emitTriangle(c2, b, a, mi, level - 1, groupName);
            emitTriangle(c3, c, b, mi, level - 1, groupName);
            emitTriangle(a, b, c, mi, level - 1, groupName);
        };

        for (const poly of polys) {
            const mi = nameToIndex.get(poly.material || "default");
            const c0 = cornerData(poly, 0);
            const groupName = fixedGroupName || poly.group || "Avatar";

            // Mesh quality refines anatomy only; accessories (Handle* groups)
            // and any explicitly excluded groups (e.g. the head) keep their
            // original density.
            const level =
                isBodyGroup(poly.group || "") &&
                !excludeSubdivisionSet.has(poly.group)
                    ? safeSubdivision
                    : 0;

            // Triangle fan, subdivided when a mesh-quality level is selected.
            for (let i = 1; i < poly.corners.length - 1; i++) {
                emitTriangle(
                    c0,
                    cornerData(poly, i),
                    cornerData(poly, i + 1),
                    mi,
                    level,
                    groupName
                );
            }
        }

        const geometry = new T.BufferGeometry();
        geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
        geometry.setAttribute("normal", new T.Float32BufferAttribute(normals, 3));
        geometry.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));

        if (rigData && !recenter) {
            geometry.setAttribute("skinIndex", new T.Uint16BufferAttribute(skinIndices, 4));
            geometry.setAttribute("skinWeight", new T.Float32BufferAttribute(skinWeights, 4));
        }

        geometry.setIndex(indices);

        let offset = 0;
        for (let mi = 0; mi < usedNames.length; mi++) {
            const count = groupCounts[mi] || 0;
            if (count > 0) {
                geometry.addGroup(offset, count, mi);
            }
            offset += count;
        }

        return { geometry, materials: usedNames.map(materialFor) };
    };

    // Bounding-box centre (FBX space) of a part's polygons.
    const partCenter = (polys) => {
        const box = new T.Box3();
        const v = new T.Vector3();

        for (const poly of polys) {
            for (const idx of poly.corners) {
                const pos = obj.positions[idx.p];
                v.set(
                    -(pos[0] - offsetX),
                    pos[1] - offsetY,
                    -(pos[2] - offsetZ)
                );
                box.expandByPoint(v);
            }
        }

        const center = new T.Vector3();
        box.getCenter(center);
        return center;
    };

    const scene = new T.Scene();

    // Collect the parts to build (one entry per OBJ group in split mode, or a
    // single merged part otherwise).
    const partList = [];

    if (splitParts) {
        const byGroup = new Map();

        for (const poly of obj.polygons) {
            const key = poly.group || "Avatar";

            if (!byGroup.has(key)) {
                byGroup.set(key, []);
            }

            byGroup.get(key).push(poly);
        }

        for (const [name, polys] of byGroup) {
            partList.push({ name, polys });
        }
    } else {
        partList.push({ name: "character_mesh", polys: obj.polygons });
    }

    // A container holds the armature and the (skinned) meshes.
    const container = new T.Group();
    container.name = groupName || "Avatar";
    scene.add(container);

    let skeleton = null;
    const boneByName = {};

    if (rigData) {
        const boneNames = Object.keys(rigData.joints);
        const bones = [];

        for (const name of boneNames) {
            const bone = new T.Bone();
            bone.name = name;
            boneByName[name] = bone;
            bones.push(bone);
        }

        // World head positions in the same space as the geometry (Y-up,
        // 180° around Y, body-centred, feet at 0).
        const head = {};
        for (const name of boneNames) {
            const p = rigData.joints[name];
            head[name] = new T.Vector3(
                -(p[0] - offsetX),
                p[1] - offsetY,
                -(p[2] - offsetZ)
            );
        }

        const childrenOf = {};
        let rootName = null;

        for (const name of boneNames) {
            const parentName = rigData.parentOf[name];

            if (parentName && boneByName[parentName]) {
                boneByName[parentName].add(boneByName[name]);
                (childrenOf[parentName] = childrenOf[parentName] || []).push(name);
            } else {
                rootName = name;
            }
        }

        // Orient each bone's local +Y (head→tail) toward its first child so
        // Blender draws the bones along the limbs instead of pointing them all
        // up. Leaf bones continue the parent's direction. Parents are processed
        // before children, and each child's local position is recomputed in the
        // parent's rotated frame so the joint positions never move.
        const yAxis = new T.Vector3(0, 1, 0);
        const worldQuat = {};
        const dir = new T.Vector3();
        const desired = new T.Quaternion();
        const invParent = new T.Quaternion();

        const parentWorldQuat = (name) =>
            worldQuat[rigData.parentOf[name]] || new T.Quaternion();

        const orient = (name) => {
            const bone = boneByName[name];
            const kids = childrenOf[name] || [];

            if (kids.length) {
                dir.copy(head[kids[0]]).sub(head[name]);

                if (dir.lengthSq() < 1e-8) {
                    dir.copy(yAxis).applyQuaternion(parentWorldQuat(name));
                } else {
                    dir.normalize();
                }
            } else {
                // Leaf: keep pointing the way the parent points.
                dir.copy(yAxis).applyQuaternion(parentWorldQuat(name)).normalize();
            }

            desired.setFromUnitVectors(yAxis, dir);
            worldQuat[name] = desired.clone();

            const parentName = rigData.parentOf[name];

            if (parentName && boneByName[parentName]) {
                const pq = parentWorldQuat(name);

                bone.quaternion.copy(pq).invert().multiply(desired);

                invParent.copy(pq).invert();
                bone.position
                    .copy(head[name])
                    .sub(head[parentName])
                    .applyQuaternion(invParent);
            } else {
                bone.position.copy(head[name]);
                bone.quaternion.copy(desired);
            }

            for (const child of kids) {
                orient(child);
            }
        };

        if (rootName) {
            orient(rootName);
        }

        container.add(boneByName[rootName]);

        // Bone inverses are captured from the rest pose (after orientation).
        scene.updateMatrixWorld(true);
        skeleton = new T.Skeleton(bones);
    }

    for (const part of partList) {
        const isHandle = splitParts && rigData && /^handle/i.test(part.name);
        // Layered clothing (R15) spans several body parts and must deform with
        // the skeleton; other handles stay rigid children of one bone.
        const isClothing = !!(isHandle && rigData.isClothingGroup(part.name));

        if (isClothing) {
            // Skinned clothing: generate skin attributes and bind to the
            // skeleton instead of rigidly parenting to a single bone.
            const built = buildPart(
                part.polys,
                splitParts ? part.name : null,
                null,
                (groupName, x, y, z) => rigData.skinClothingFor(x, y, z)
            );
            const mesh = new T.SkinnedMesh(built.geometry, built.materials);
            mesh.name = part.name;
            mesh.bind(skeleton, new T.Matrix4());
            mesh.frustumCulled = false;
            container.add(mesh);
            continue;
        }

        const handleBone = isHandle ? rigData.handleBoneMap[part.name] : null;
        const recenter = isHandle ? partCenter(part.polys) : null;

        const built = buildPart(part.polys, splitParts ? part.name : null, recenter);

        let mesh;

        if (rigData && !isHandle) {
            mesh = new T.SkinnedMesh(built.geometry, built.materials);
            mesh.name = part.name;
            // Identity bind matrix: geometry and bones already share the same
            // (FBX) space.
            mesh.bind(skeleton, new T.Matrix4());
            mesh.frustumCulled = false;
            container.add(mesh);
        } else if (isHandle) {
            // Rigid child of the parent bone (not skinned); node transform keeps
            // the centered geometry at its original world position.
            mesh = new T.Mesh(built.geometry, built.materials);
            mesh.name = part.name;
            mesh.frustumCulled = false;

            const bone = handleBone ? boneByName[handleBone] : null;

            if (bone) {
                mesh.position.copy(bone.worldToLocal(recenter.clone()));
                mesh.quaternion.copy(
                    bone.getWorldQuaternion(new T.Quaternion()).invert()
                );
                bone.add(mesh);
            } else {
                mesh.position.copy(recenter);
                container.add(mesh);
            }
        } else {
            mesh = new T.Mesh(built.geometry, built.materials);
            mesh.name = part.name;
            container.add(mesh);
        }
    }

    const exporter = new FBXExporter();
    const fbxBytes = exporter.parseSync(scene, {
        binary: true,
        embedTextures,
        // Y-up, Z-forward, unit scale 100: Blender imports metres at the
        // right size instead of treating the model as centimetres.
        preset: "blender"
    });

    return Buffer.from(fbxBytes);
}

module.exports = { buildFbx };
