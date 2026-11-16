"use strict";

// Binary FBX 7.4 exporter.
// Builds a Three.js scene from the downloaded avatar OBJ + MTL (+ textures) and
// serializes it with @comfyorg/fbx-exporter-three (binary FBX, embedded textures).
//
// The output is a genuine binary .fbx ("Kaydara FBX Binary") that Blender 3.6+,
// Unity, Unreal, F3D and other importers accept — unlike ASCII FBX, which many
// tools reject.
//
// Interface (kept stable for backend/convert.js):
//   buildFbx({ objText, mtlText, assetDir }) -> Promise<Buffer>

const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

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
                polygons.push({ corners, material: currentMaterial });
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

        return new THREE.DataTexture(
            new Uint8ClampedArray(png.data),
            png.width,
            png.height,
            THREE.RGBAFormat
        );
    } catch {
        return null;
    }
}

async function buildFbx({ objText, mtlText, assetDir }) {
    const { THREE: T, FBXExporter } = await ensureModules();

    const obj = parseObj(objText);
    const mtl = mtlText ? parseMtl(mtlText) : new Map();

    if (obj.polygons.length === 0) {
        throw new Error("FBX conversion failed: the OBJ has no faces.");
    }

    // Material name -> index, stable order.
    const matNames = [...new Set(obj.polygons.map((poly) => poly.material || "default"))];
    const matIndex = new Map(matNames.map((name, i) => [name, i]));

    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const groupCounts = {};

    let vertexIndex = 0;

    for (const poly of obj.polygons) {
        const mi = matIndex.get(poly.material || "default");
        groupCounts[mi] = (groupCounts[mi] || 0) + 3 * Math.max(1, poly.corners.length - 2);

        // Triangle fan.
        for (let i = 1; i < poly.corners.length - 1; i++) {
            const tris = [poly.corners[0], poly.corners[i], poly.corners[i + 1]];

            for (const c of tris) {
                const pos = obj.positions[c.p];
                positions.push(pos[0], pos[1], pos[2]);

                const n = (c.n !== null && obj.normals[c.n]) ? obj.normals[c.n] : [0, 1, 0];
                normals.push(n[0], n[1], n[2]);

                const uv = (c.t !== null && obj.uvs[c.t]) ? obj.uvs[c.t] : [0, 0];
                uvs.push(uv[0], 1 - uv[1]);

                indices.push(vertexIndex++);
            }
        }
    }

    const geometry = new T.BufferGeometry();
    geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new T.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);

    // One draw range per material.
    let offset = 0;
    for (let mi = 0; mi < matNames.length; mi++) {
        const count = groupCounts[mi] || 0;
        if (count > 0) {
            geometry.addGroup(offset, count, mi);
        }
        offset += count;
    }

    // Load embedded textures.
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

    const materials = matNames.map((name) => {
        const material = mtl.get(name) || { Kd: [0.8, 0.8, 0.8] };
        return new T.MeshPhongMaterial({
            color: new T.Color(material.Kd[0], material.Kd[1], material.Kd[2]),
            map: texMap.get(name) || undefined
        });
    });

    const mesh = new T.Mesh(geometry, materials);
    const scene = new T.Scene();
    scene.add(mesh);

    const exporter = new FBXExporter();
    const fbxBytes = exporter.parseSync(scene, { binary: true, embedTextures: true });

    return Buffer.from(fbxBytes);
}

module.exports = { buildFbx };
