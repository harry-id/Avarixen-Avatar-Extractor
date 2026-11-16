#!/usr/bin/env node
'use strict';

/**
 * Generates a simple rigged test model GLB for Blender import testing.
 *
 * The model is a vertical capsule-like mesh (12 vertices) with two bones:
 *   - Root (at base)
 *   - Limb (at mid-height, parented to Root)
 *
 * The top half of the mesh is weighted to "Limb", the bottom half to "Root".
 * Rotating the Limb bone in Blender should deform only the top half.
 *
 * Output: /tmp/opencode/test_model.glb
 */

const fs = require("fs");
const path = require("path");
const { Document, NodeIO, Accessor } = require("@gltf-transform/core");

const OUT = "/tmp/opencode/test_model.glb";

const doc = new Document();
const root = doc.getRoot();
const scene = doc.createScene("Scene");
const buffer = doc.createBuffer();

function createAccessor(array, typeStr, componentType, normalized = false) {
    const acc = doc.createAccessor();
    acc.setType(typeStr);
    acc.set("componentType", componentType);
    acc.setArray(array);
    acc.setNormalized(normalized);
    acc.setBuffer(buffer);
    return acc;
}

// ---- Mesh: a vertical stack of 4 quads (8 rings x ... actually simple)
// 12 vertices: 4 around bottom, 4 around middle, 4 around top
// y: 0 (bottom), 1 (middle), 2 (top)
// radius: 0.5
const positions = new Float32Array([
    // bottom ring (y=0)
    0.5, 0, 0.5,   -0.5, 0, 0.5,   -0.5, 0, -0.5,    0.5, 0, -0.5,
    // middle ring (y=1)
    0.5, 1, 0.5,   -0.5, 1, 0.5,   -0.5, 1, -0.5,    0.5, 1, -0.5,
    // top ring (y=2)
    0.5, 2, 0.5,   -0.5, 2, 0.5,   -0.5, 2, -0.5,    0.5, 2, -0.5,
]);

const normals = new Float32Array([
    0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
]);

const uvs = new Float32Array([
    1, 1, 0, 1, 0, 0, 1, 0,
    1, 0.5, 0, 0.5, 0, 0.5, 1, 0.5,
    1, 0, 0, 0, 0, 0, 1, 0,
]);

const colors = new Float32Array([
    1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1,   // bottom: red
    1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1,   // middle: yellow
    0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1,   // top: green
]);

// Indices: 8 quads = 16 triangles (bottom ring, middle ring, side quads)
const indices = [];
// Bottom cap
indices.push(0, 1, 2, 0, 2, 3);
// Top cap
indices.push(8, 9, 10, 8, 10, 11);
// Side quads (4 around)
for (let i = 0; i < 4; i++) {
    const a = i;
    const b = (i + 1) % 4;
    const c = 4 + b;
    const d = 4 + a;
    indices.push(a, b, c, a, c, d);
    const e = 4 + a;
    const f = 4 + b;
    const g = 8 + b;
    const h = 8 + a;
    indices.push(e, f, g, e, g, h);
}

// ---- Skinning weights ----
// Bottom 4 vertices -> Root (joint 0)
// Middle 4 vertices -> split 50/50
// Top 4 vertices -> Limb (joint 1)
const joints = new Float32Array(12 * 4);
const weights = new Float32Array(12 * 4);
for (let i = 0; i < 12; i++) {
    joints[i * 4] = 0;
    joints[i * 4 + 1] = 1;
    joints[i * 4 + 2] = 0;
    joints[i * 4 + 3] = 0;
    if (i < 4) {
        // bottom -> Root only
        weights[i * 4] = 1.0;
        weights[i * 4 + 1] = 0.0;
    } else if (i < 8) {
        // middle -> split Root/Limb
        weights[i * 4] = 0.5;
        weights[i * 4 + 1] = 0.5;
    } else {
        // top -> Limb only
        weights[i * 4] = 0.0;
        weights[i * 4 + 1] = 1.0;
    }
}

// ---- Material ----
const mat = doc.createMaterial("test_mat")
    .setBaseColorFactor([0.8, 0.4, 0.2, 1.0]);

// ---- Mesh + Primitive ----
const mesh = doc.createMesh("test_mesh");
const prim = doc.createPrimitive()
    .setMode(4) // TRIANGLES
    .setAttribute("POSITION", createAccessor(positions, "VEC3", Accessor.ComponentType.FLOAT))
    .setAttribute("NORMAL", createAccessor(normals, "VEC3", Accessor.ComponentType.FLOAT))
    .setAttribute("TEXCOORD_0", createAccessor(uvs, "VEC2", Accessor.ComponentType.FLOAT))
    .setAttribute("COLOR_0", createAccessor(colors, "VEC4", Accessor.ComponentType.UNSIGNED_BYTE, true))
    .setAttribute("JOINTS_0", createAccessor(new Uint16Array(Array.from(joints)), "VEC4", Accessor.ComponentType.UNSIGNED_SHORT))
    .setAttribute("WEIGHTS_0", createAccessor(weights, "VEC4", Accessor.ComponentType.FLOAT))
    .setIndices(createAccessor(new Uint16Array(indices), "SCALAR", Accessor.ComponentType.UNSIGNED_SHORT))
    .setMaterial(mat);
mesh.addPrimitive(prim);

// ---- Joint nodes ----
const rootNode = doc.createNode("Root");
rootNode.setTranslation([0, 0, 0]);
scene.addChild(rootNode);

const limbNode = doc.createNode("Limb");
limbNode.setTranslation([0, 1, 0]);
rootNode.addChild(limbNode);

const meshNode = doc.createNode("test_mesh");
meshNode.setMesh(mesh);

// ---- Skin ----
const skin = doc.createSkin("test_skin");
skin.addJoint(rootNode);
skin.addJoint(limbNode);
skin.setSkeleton(rootNode);

// Inverse bind matrices (pure translation)
const ibm = new Float32Array(2 * 16);
// Root: translate(0,0,0) -> identity
ibm[0] = 1; ibm[1] = 0; ibm[2] = 0; ibm[3] = 0;
ibm[4] = 0; ibm[5] = 1; ibm[6] = 0; ibm[7] = 0;
ibm[8] = 0; ibm[9] = 0; ibm[10] = 1; ibm[11] = 0;
ibm[12] = 0; ibm[13] = 0; ibm[14] = 0; ibm[15] = 1;
// Limb: translate(0,1,0) inverse = translate(0,-1,0)
ibm[16] = 1; ibm[17] = 0; ibm[18] = 0; ibm[19] = 0;
ibm[20] = 0; ibm[21] = 1; ibm[22] = 0; ibm[23] = 0;
ibm[24] = 0; ibm[25] = 0; ibm[26] = 1; ibm[27] = 0;
ibm[28] = 0; ibm[29] = -1; ibm[30] = 0; ibm[31] = 1;
skin.setInverseBindMatrices(createAccessor(ibm, "MAT4", Accessor.ComponentType.FLOAT));

meshNode.setSkin(skin);
scene.addChild(meshNode);

// ---- Write GLB ----
const io = new NodeIO();
io.write(OUT, doc).then(() => {
    console.log("Written:", OUT);
    console.log("You can now import this in Blender:");
    console.log("  File > Import > glTF 2.0 (.glb/.gltf)");
    console.log("  Then rotate the 'Limb' bone in Pose Mode — the top half should move, bottom half stays still.");
}).catch(err => {
    console.error("Error:", err);
    process.exit(1);
});
