"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
