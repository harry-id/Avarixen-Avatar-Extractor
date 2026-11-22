"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PNG } = require("pngjs");

const { buildFbx } = require("../fbx-exporter");

async function loadFbx(buffer) {
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    const loader = new FBXLoader();
    return loader.parse(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        ""
    );
}

const OBJ = `mtllib avatar.mtl
v 0 0 0
v 1 0 0
v 0 1 0
vt 0 0
vt 1 0
vt 0 1
vn 0 0 1
usemtl cloth
f 1/1/1 2/2/1 3/3/1
`;

const MTL = `newmtl cloth
Kd 1 1 1
`;

test("buildFbx produces a binary FBX buffer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), OBJ);
        fs.writeFileSync(path.join(dir, "avatar.mtl"), MTL);

        const fbx = await buildFbx({
            objText: OBJ,
            mtlText: MTL,
            assetDir: dir
        });

        assert.ok(Buffer.isBuffer(fbx));
        assert.ok(fbx.length > 0);
        assert.equal(fbx.subarray(0, 20).toString("ascii").startsWith("Kaydara FBX Binary"), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("buildFbx splits body parts in compatibility mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));

    const obj = [
        "g Head",
        "v 0 12 0",
        "v 1 12 0",
        "v 0 13 0",
        "f 1 2 3",
        "g Torso",
        "v 0 8 0",
        "v 1 8 0",
        "v 0 9 0",
        "f 4 5 6",
        ""
    ].join("\n");

    try {
        const fbx = await buildFbx({
            objText: obj,
            mtlText: "",
            assetDir: dir,
            splitParts: true,
            groupName: "Tester"
        });

        assert.ok(Buffer.isBuffer(fbx));
        assert.equal(fbx.subarray(0, 20).toString("ascii").startsWith("Kaydara FBX Binary"), true);
        assert.equal(fbx.includes(Buffer.from("Tester")), true);
        assert.equal(fbx.includes(Buffer.from("Head")), true);
        assert.equal(fbx.includes(Buffer.from("Torso")), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("buildFbx rejects an OBJ without faces", async () => {
    await assert.rejects(
        () => buildFbx({
            objText: "v 0 0 0\n",
            mtlText: "",
            assetDir: os.tmpdir()
        }),
        /no faces/
    );
});

test("buildFbx references external textures when embedding is disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));
    const png = new PNG({ width: 1, height: 1 });
    png.data.fill(255);

    const obj = [
        "mtllib avatar.mtl",
        "g Head",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "vt 0 0",
        "vt 1 0",
        "vt 0 1",
        "usemtl cloth",
        "f 1/1 2/2 3/3",
        ""
    ].join("\n");
    const mtl = "newmtl cloth\nmap_Kd texture1.png\n";

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);
        fs.writeFileSync(path.join(dir, "avatar.mtl"), mtl);
        fs.writeFileSync(path.join(dir, "texture1.png"), PNG.sync.write(png));

        const fbx = await buildFbx({
            objText: obj,
            mtlText: mtl,
            assetDir: dir,
            splitParts: true,
            groupName: "Tester",
            embedTextures: false
        });

        assert.equal(fbx.includes(Buffer.from("texture1.png")), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("buildFbx subdivides geometry when a level is requested", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));
    const obj = [
        "g Torso",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "vt 0 0",
        "vt 1 0",
        "vt 0 1",
        "vn 0 0 1",
        "usemtl cloth",
        "f 1/1/1 2/2/1 3/3/1",
        ""
    ].join("\n");
    const mtl = "newmtl cloth\nKd 1 1 1\n";

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);
        fs.writeFileSync(path.join(dir, "avatar.mtl"), mtl);

        const base = await buildFbx({ objText: obj, mtlText: mtl, assetDir: dir });
        const refined = await buildFbx({
            objText: obj,
            mtlText: mtl,
            assetDir: dir,
            splitParts: true,
            groupName: "Tester",
            subdivision: 1
        });

        assert.ok(Buffer.isBuffer(refined));
        assert.equal(refined.subarray(0, 20).toString("ascii").startsWith("Kaydara FBX Binary"), true);

        const vertexCount = async (buffer) => {
            const group = await loadFbx(buffer);
            let count = 0;
            group.traverse((object) => {
                if (object.isMesh) {
                    count += object.geometry.attributes.position.count;
                }
            });
            return count;
        };

        assert.ok(await vertexCount(refined) > await vertexCount(base));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const R6_OBJ = [
    "g Head", "v 0 10 0", "v 1 10 0", "v 0 11 0", "f 1 2 3",
    "g Torso", "v -1 5 0", "v 1 5 0", "v 0 7 0", "f 4 5 6",
    "g LeftArm", "v -2 6 0", "v -1 6 0", "v -1.5 8 0", "f 7 8 9",
    "g RightArm", "v 1 6 0", "v 2 6 0", "v 1.5 8 0", "f 10 11 12",
    "g LeftLeg", "v -1 1 0", "v 0 1 0", "v -0.5 4 0", "f 13 14 15",
    "g RightLeg", "v 0 1 0", "v 1 1 0", "v 0.5 4 0", "f 16 17 18",
    ""
].join("\n");

test("buildFbx writes an armature when rig is requested", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));

    try {
        const fbx = await buildFbx({
            objText: R6_OBJ,
            mtlText: "",
            assetDir: dir,
            splitParts: true,
            groupName: "Tester",
            rig: true,
            moreJoints: true
        });

        assert.ok(fbx.length > 0);
        assert.equal(fbx.includes(Buffer.from("LimbNode")), true);
        assert.equal(fbx.includes(Buffer.from("Cluster")), true);
        assert.equal(fbx.includes(Buffer.from("Deformer")), true);
        assert.equal(fbx.includes(Buffer.from("Left Hand")), true);
        assert.equal(fbx.includes(Buffer.from("Waist")), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("buildFbx stays static without a rig", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));

    try {
        const fbx = await buildFbx({
            objText: R6_OBJ,
            mtlText: "",
            assetDir: dir,
            splitParts: true,
            groupName: "Tester"
        });

        assert.equal(fbx.includes(Buffer.from("LimbNode")), false);
        assert.equal(fbx.includes(Buffer.from("Cluster")), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("buildFbx preserves vertex colors and material opacity", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));
    const obj = [
        "g Torso",
        "v 0 0 0 1 0 0",
        "v 1 0 0 0 1 0",
        "v 0 1 0 0 0 1",
        "usemtl cloth",
        "f 1 2 3",
        ""
    ].join("\n");
    const mtl = "newmtl cloth\nKd 1 1 1\nd 0.4\n";

    try {
        const fbx = await buildFbx({
            objText: obj,
            mtlText: mtl,
            assetDir: dir,
            splitParts: true,
            groupName: "Tester"
        });
        const group = await loadFbx(fbx);
        let mesh = null;
        group.traverse((object) => {
            if (object.isMesh && object.name === "Torso") {
                mesh = object;
            }
        });

        assert.ok(mesh);
        assert.ok(mesh.geometry.attributes.color);
        assert.equal(mesh.geometry.attributes.color.count, 3);
        assert.equal(mesh.material.opacity, 0.4);
        assert.equal(mesh.material.transparent, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("buildFbx supports ungrouped OBJ with negative indices", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));
    const obj = [
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f -3 -2 -1",
        ""
    ].join("\n");

    try {
        const fbx = await buildFbx({
            objText: obj,
            mtlText: "",
            assetDir: dir,
            splitParts: true,
            groupName: "Tester"
        });
        const group = await loadFbx(fbx);
        let mesh = null;
        group.traverse((object) => {
            if (object.isMesh) {
                mesh = object;
            }
        });

        assert.ok(mesh);
        assert.equal(mesh.geometry.attributes.position.count, 3);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
