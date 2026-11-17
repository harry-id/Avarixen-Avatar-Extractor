"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PNG } = require("pngjs");

const { buildFbx } = require("../fbx-exporter");

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
