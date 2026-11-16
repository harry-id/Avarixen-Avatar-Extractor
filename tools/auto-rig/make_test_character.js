#!/usr/bin/env node
'use strict';

/**
 * Generates a full mini test character GLB for Blender import testing.
 *
 * Uses separate buffer views per attribute (no interleaving) for maximum
 * Blender compatibility.
 *
 * A simple capsule-style character with 7 bones (R6-style):
 *   Root (hips), Torso, Head, Left Arm, Right Arm, Left Leg, Right Leg
 *
 * Each body segment has distinct vertex colors. Rotate any bone in Pose Mode
 * and watch its segment move.
 *
 * Output: /tmp/opencode/test_character.glb
 */

const fs = require("fs");

const OUT = "/tmp/opencode/test_character.glb";

// ---- Geometry: vertical capsule rings ----
const SEG = 12;
const R = 0.25;

function capsuleSegment(radius, y0, y1, nSegs, color) {
    const positions = [];
    const normals = [];
    const colors = [];
    const indices = [];

    for (let s = 0; s < nSegs; s++) {
        const a = (s / nSegs) * Math.PI * 2;
        positions.push(Math.cos(a) * radius, y0, Math.sin(a) * radius);
        normals.push(Math.cos(a), 0, Math.sin(a));
        colors.push(...color);
    }
    for (let s = 0; s < nSegs; s++) {
        const a = (s / nSegs) * Math.PI * 2;
        positions.push(Math.cos(a) * radius, y1, Math.sin(a) * radius);
        normals.push(Math.cos(a), 0, Math.sin(a));
        colors.push(...color);
    }

    for (let s = 0; s < nSegs; s++) {
        const s0 = s;
        const s1 = (s + 1) % nSegs;
        const t0 = nSegs + s;
        const t1 = nSegs + s1;
        indices.push(s0, s1, t1, s0, t1, t0);
    }

    return { positions, normals, colors, indices };
}

const torso = capsuleSegment(R, 0.6, 1.4, SEG, [0.2, 0.6, 1.0, 1]);    // blue
const head = capsuleSegment(R * 0.8, 1.45, 1.9, SEG, [1.0, 0.8, 0.6, 1]); // skin
const lArm = capsuleSegment(R * 0.5, 1.0, 0.2, SEG, [1.0, 0.2, 0.2, 1]); // red
const rArm = capsuleSegment(R * 0.5, 1.0, 0.2, SEG, [1.0, 0.2, 0.2, 1]); // red
const lLeg = capsuleSegment(R * 0.6, 0.0, 0.6, SEG, [0.2, 1.0, 0.2, 1]); // green
const rLeg = capsuleSegment(R * 0.6, 0.0, 0.6, SEG, [0.2, 1.0, 0.2, 1]); // green

const segments = [torso, head, lArm, rArm, lLeg, rLeg];

// ---- Build separate attribute arrays ----
const NJ = 7;
const segToJoint = [1, 2, 3, 4, 5, 6];

const positions = [];
const normals = [];
const colors = [];      // RGBA bytes
const joints = [];      // uint16
const weights = [];     // float32
const indices = [];

let vertCount = 0;
let offset = 0;
for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const nv = seg.positions.length / 3;
    const j = segToJoint[si];
    for (let k = 0; k < nv; k++, vertCount++) {
        positions.push(seg.positions[k * 3], seg.positions[k * 3 + 1], seg.positions[k * 3 + 2]);
        normals.push(seg.normals[k * 3], seg.normals[k * 3 + 1], seg.normals[k * 3 + 2]);
        colors.push(
            Math.round(seg.colors[k * 4] * 255),
            Math.round(seg.colors[k * 4 + 1] * 255),
            Math.round(seg.colors[k * 4 + 2] * 255),
            Math.round(seg.colors[k * 4 + 3] * 255)
        );
        joints.push(j, 0, 0, 0);
        weights.push(1.0, 0.0, 0.0, 0.0);
    }
    for (const idx of seg.indices) indices.push(offset + idx);
    offset += nv;
}

const NUM_VERT = vertCount;
const NUM_INDICES = indices.length;

// ---- Build binary buffer (separate sections) ----
const POS_BYTES = NUM_VERT * 3 * 4;      // 1728
const NOR_BYTES = NUM_VERT * 3 * 4;      // 1728
const COL_BYTES = NUM_VERT * 4 * 1;      // 576
const JNT_BYTES = NUM_VERT * 4 * 2;      // 1152
const WGT_BYTES = NUM_VERT * 4 * 4;      // 2304
const IDX_BYTES = NUM_INDICES * 2;       // 864
const IBM_BYTES = NJ * 64;               // 448

const bufSize = POS_BYTES + NOR_BYTES + COL_BYTES + JNT_BYTES + WGT_BYTES + IDX_BYTES + IBM_BYTES;
const buf = Buffer.alloc(bufSize);
let boff = 0;

// POSITION
const posView = new Float32Array(buf.buffer, buf.byteOffset + boff, NUM_VERT * 3);
for (let i = 0; i < positions.length; i++) posView[i] = positions[i];
boff += POS_BYTES;

// NORMAL
const norView = new Float32Array(buf.buffer, buf.byteOffset + boff, NUM_VERT * 3);
for (let i = 0; i < normals.length; i++) norView[i] = normals[i];
boff += NOR_BYTES;

// COLOR (uint8)
for (let i = 0; i < colors.length; i++) buf[boff + i] = colors[i];
boff += COL_BYTES;

// JOINTS (uint16)
const jntView = new Uint16Array(buf.buffer, buf.byteOffset + boff, NUM_VERT * 4);
for (let i = 0; i < joints.length; i++) jntView[i] = joints[i];
boff += JNT_BYTES;

// WEIGHTS (float32)
const wgtView = new Float32Array(buf.buffer, buf.byteOffset + boff, NUM_VERT * 4);
for (let i = 0; i < weights.length; i++) wgtView[i] = weights[i];
boff += WGT_BYTES;

// INDICES (uint16)
const idxView = new Uint16Array(buf.buffer, buf.byteOffset + boff, NUM_INDICES);
for (let i = 0; i < NUM_INDICES; i++) idxView[i] = indices[i];
boff += IDX_BYTES;

// INVERSE BIND MATRICES
const jointTranslations = [
    [0, 0.3, 0], [0, 1.0, 0], [0, 1.7, 0],
    [-0.45, 1.15, 0], [0.45, 1.15, 0],
    [-0.2, 0.15, 0], [0.2, 0.15, 0],
];
for (let j = 0; j < NJ; j++) {
    const t = jointTranslations[j];
    const base = boff + j * 64;
    buf.writeFloatLE(1, base + 0);  buf.writeFloatLE(0, base + 4);  buf.writeFloatLE(0, base + 8);  buf.writeFloatLE(0, base + 12);
    buf.writeFloatLE(0, base + 16); buf.writeFloatLE(1, base + 20); buf.writeFloatLE(0, base + 24); buf.writeFloatLE(0, base + 28);
    buf.writeFloatLE(0, base + 32); buf.writeFloatLE(0, base + 36); buf.writeFloatLE(1, base + 40); buf.writeFloatLE(0, base + 44);
    buf.writeFloatLE(-t[0], base + 48); buf.writeFloatLE(-t[1], base + 52); buf.writeFloatLE(-t[2], base + 56); buf.writeFloatLE(1, base + 60);
}

// ---- Build glTF JSON ----
const json = {
    asset: { version: "2.0", generator: "test-character-generator" },
    scene: 0,
    scenes: [{ nodes: [7] }],
    nodes: [
        { name: "Root", translation: [0, 0.3, 0], children: [1, 5, 6] },
        { name: "Torso", translation: [0, 1.0, 0], children: [2, 3, 4] },
        { name: "Head", translation: [0, 1.7, 0] },
        { name: "L Arm", translation: [-0.45, 1.15, 0] },
        { name: "R Arm", translation: [0.45, 1.15, 0] },
        { name: "L Leg", translation: [-0.2, 0.15, 0] },
        { name: "R Leg", translation: [0.2, 0.15, 0] },
        { name: "character_mesh", mesh: 0, skin: 0 },
    ],
    meshes: [{
        name: "character_mesh",
        primitives: [{
            attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2, JOINTS_0: 3, WEIGHTS_0: 4 },
            indices: 5,
            material: 0,
        }],
    }],
    materials: [{
        name: "body_mat",
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] },
    }],
    skins: [{
        name: "character_skin",
        skeleton: 0,
        joints: [0, 1, 2, 3, 4, 5, 6],
        inverseBindMatrices: 6,
    }],
    accessors: [
        { bufferView: 0, byteOffset: 0, componentType: 5126, count: NUM_VERT, type: "VEC3" },           // 0 POSITION
        { bufferView: 1, byteOffset: 0, componentType: 5126, count: NUM_VERT, type: "VEC3" },           // 1 NORMAL
        { bufferView: 2, byteOffset: 0, componentType: 5121, count: NUM_VERT, type: "VEC4", normalized: true }, // 2 COLOR_0
        { bufferView: 3, byteOffset: 0, componentType: 5123, count: NUM_VERT, type: "VEC4" },           // 3 JOINTS_0
        { bufferView: 4, byteOffset: 0, componentType: 5126, count: NUM_VERT, type: "VEC4" },           // 4 WEIGHTS_0
        { bufferView: 5, byteOffset: 0, componentType: 5123, count: NUM_INDICES, type: "SCALAR" },      // 5 indices
        { bufferView: 6, byteOffset: 0, componentType: 5126, count: NJ, type: "MAT4" },                 // 6 IBM
    ],
    bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: POS_BYTES, target: 34962 },       // 0
        { buffer: 0, byteOffset: POS_BYTES, byteLength: NOR_BYTES, target: 34962 }, // 1
        { buffer: 0, byteOffset: POS_BYTES + NOR_BYTES, byteLength: COL_BYTES },    // 2
        { buffer: 0, byteOffset: POS_BYTES + NOR_BYTES + COL_BYTES, byteLength: JNT_BYTES }, // 3
        { buffer: 0, byteOffset: POS_BYTES + NOR_BYTES + COL_BYTES + JNT_BYTES, byteLength: WGT_BYTES }, // 4
        { buffer: 0, byteOffset: POS_BYTES + NOR_BYTES + COL_BYTES + JNT_BYTES + WGT_BYTES, byteLength: IDX_BYTES, target: 34963 }, // 5
        { buffer: 0, byteOffset: POS_BYTES + NOR_BYTES + COL_BYTES + JNT_BYTES + WGT_BYTES + IDX_BYTES, byteLength: IBM_BYTES }, // 6
    ],
    buffers: [{ byteLength: bufSize }],
};

const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);

function chunkHeader(type, length) {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(length, 0);
    h.write(type, 4);
    return h;
}

const glbHeader = Buffer.alloc(12);
glbHeader.write("glTF", 0);
glbHeader.writeUInt32LE(2, 4);
glbHeader.writeUInt32LE(
    12 + 8 + jsonChunk.length + 8 + buf.length,
    8
);

fs.writeFileSync(OUT, Buffer.concat([
    glbHeader,
    chunkHeader("JSON", jsonChunk.length),
    jsonChunk,
    chunkHeader("BIN", buf.length),
    buf,
]));

console.log("Written:", OUT);
console.log("Vertices:", NUM_VERT, "Indices:", NUM_INDICES, "Bones:", NJ);
console.log("");
console.log("Bones: Root, Torso, Head, L Arm, R Arm, L Leg, R Leg");
console.log("Segments (colors): Torso=blue, Head=skin, Arms=red, Legs=green");
console.log("");
console.log("In Blender:");
console.log("  1. File > Import > glTF 2.0 -> select this .glb");
console.log("  2. Select armature, go to Pose Mode");
console.log("  3. Select a bone, rotate it (R -> X/Y/Z -> angle)");
console.log("  4. Only that bone's colored segment should move");
