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

        // Deep artifact validation: the binary must decode into a scene that
        // contains mesh geometry with non-empty vertex data and a material.
        const group = await loadFbx(fbx);
        const meshes = [];
        group.traverse((object) => {
            if (object.isMesh) {
                meshes.push(object);
            }
        });
        assert.ok(meshes.length > 0, "FBX export should contain at least one mesh");
        const mesh = meshes[0];
        assert.ok(mesh.geometry.attributes.position);
        assert.ok(mesh.geometry.attributes.position.count > 0, "FBX geometry must have non-empty vertex data");
        assert.ok(mesh.material);
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

test("buildFbx embeds one copy of a texture shared by multiple materials", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(200);

    const obj = [
        "mtllib avatar.mtl",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "vt 0 0",
        "vt 1 0",
        "vt 0 1",
        "usemtl clothA",
        "g Head",
        "f 1/1 2/2 3/3",
        "usemtl clothB",
        "g Torso",
        "f 1/1 2/2 3/3",
        ""
    ].join("\n");
    const mtl = [
        "newmtl clothA",
        "Kd 1 1 1",
        "map_Kd texture1.png",
        "",
        "newmtl clothB",
        "Kd 0.5 0.5 0.5",
        "map_Kd texture1.png",
        ""
    ].join("\n");

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);
        fs.writeFileSync(path.join(dir, "avatar.mtl"), mtl);
        fs.writeFileSync(path.join(dir, "texture1.png"), PNG.sync.write(png));

        const fbx = await buildFbx({
            objText: obj,
            mtlText: mtl,
            assetDir: dir,
            splitParts: true,
            groupName: "Tester"
        });

        // The FBX texture encoder emits PNG for RGBA DataTextures. Count the
        // PNG signature: a shared texture must be embedded exactly once.
        const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        let embedded = 0;
        let index = 0;
        while ((index = fbx.indexOf(pngSignature, index)) !== -1) {
            embedded += 1;
            index += pngSignature.length;
        }

        assert.equal(embedded, 1, "shared texture must be embedded once");
        // The texture is still referenced by the material(s).
        assert.equal(fbx.includes(Buffer.from("texture1.png")), true);
        assert.ok(fbx.length > 0, "FBX must still contain geometry");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---- Layered-clothing metadata gate (FBX parity) ----

function boxLines(name, box, startIndex) {
    const [xmin, xmax, ymin, ymax, zmin, zmax] = box;
    const corners = [
        [xmin, ymin, zmin], [xmax, ymin, zmin], [xmax, ymax, zmin], [xmin, ymax, zmin],
        [xmin, ymin, zmax], [xmax, ymin, zmax], [xmax, ymax, zmax], [xmin, ymax, zmax]
    ];
    const lines = [`g ${name}`];
    for (const c of corners) lines.push(`v ${c[0]} ${c[1]} ${c[2]}`);
    const faces = [
        [1, 2, 3], [1, 3, 4], [5, 6, 7], [5, 7, 8],
        [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6],
        [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8]
    ];
    for (const f of faces) {
        lines.push(`f ${startIndex + f[0] - 1} ${startIndex + f[1] - 1} ${startIndex + f[2] - 1}`);
    }
    return { text: lines.join("\n"), next: startIndex + 8 };
}

function r15ObjWithMultiRegionHandle() {
    const boxes = {
        Head: [-0.5, 0.5, 9, 11, -0.5, 0.5],
        UpperTorso: [-1, 1, 7, 9, -0.5, 0.5],
        LowerTorso: [-1, 1, 5, 7, -0.5, 0.5],
        LeftUpperArm: [-2, -1.2, 7, 9, -0.3, 0.3],
        RightUpperArm: [1.2, 2, 7, 9, -0.3, 0.3],
        LeftLowerArm: [-2, -1.5, 5, 7, -0.3, 0.3],
        RightLowerArm: [1.5, 2, 5, 7, -0.3, 0.3],
        LeftHand: [-2, -1.5, 4, 5, -0.3, 0.3],
        RightHand: [1.5, 2, 4, 5, -0.3, 0.3],
        LeftUpperLeg: [-0.8, -0.1, 2, 5, -0.3, 0.3],
        RightUpperLeg: [0.1, 0.8, 2, 5, -0.3, 0.3],
        LeftLowerLeg: [-0.8, -0.1, 0.5, 2, -0.3, 0.3],
        RightLowerLeg: [0.1, 0.8, 0.5, 2, -0.3, 0.3],
        LeftFoot: [-0.8, -0.1, 0, 0.5, -0.3, 0.3],
        RightFoot: [0.1, 0.8, 0, 0.5, -0.3, 0.3],
        Handle1: [-1.5, 1.5, 6, 8, -0.4, 0.4]
    };

    const parts = [];
    let index = 1;
    for (const [name, box] of Object.entries(boxes)) {
        const built = boxLines(name, box, index);
        parts.push(built.text);
        index = built.next;
    }
    return parts.join("\n");
}

function writeAvatarMeta(dir, assets, playerAvatarType = "R15") {
    fs.writeFileSync(
        path.join(dir, "avatar.json"),
        JSON.stringify({ userId: "1", playerAvatarType, assets })
    );
}

async function fbxMeshes(fbx) {
    const group = await loadFbx(fbx);
    const meshes = [];
    group.traverse((object) => {
        if (object.isMesh) meshes.push(object);
    });
    return meshes;
}

test("FBX keeps rigid-only R15 handles as Mesh (no skin attributes)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));
    const obj = r15ObjWithMultiRegionHandle();

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);
        fs.writeFileSync(path.join(dir, "avatar.mtl"), "newmtl cloth\nKd 1 1 1\n");
        writeAvatarMeta(dir, [{ assetType: { id: 8, name: "Hat" } }]);

        const fbx = await buildFbx({
            objText: obj,
            mtlText: "newmtl cloth\nKd 1 1 1\n",
            assetDir: dir,
            splitParts: true,
            groupName: "Tester",
            rig: true,
            bendAccessories: true
        });

        const meshes = await fbxMeshes(fbx);
        const handle = meshes.find((mesh) => /^handle/i.test(mesh.name));
        const body = meshes.find((mesh) => !/^handle/i.test(mesh.name));

        assert.ok(handle, "expected a handle mesh");
        assert.ok(body, "expected a body mesh");
        assert.ok(!handle.isSkinnedMesh, "rigid-only handle must be a Mesh");
        assert.ok(!handle.geometry.attributes.skinIndex);
        assert.equal(body.isSkinnedMesh, true, "body parts must remain skinned");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("FBX keeps layered R15 handles as SkinnedMesh with skin attributes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));
    const obj = r15ObjWithMultiRegionHandle();

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);
        fs.writeFileSync(path.join(dir, "avatar.mtl"), "newmtl cloth\nKd 1 1 1\n");
        writeAvatarMeta(dir, [{ assetType: { id: 68, name: "SweaterAccessory" } }]);

        const fbx = await buildFbx({
            objText: obj,
            mtlText: "newmtl cloth\nKd 1 1 1\n",
            assetDir: dir,
            splitParts: true,
            groupName: "Tester",
            rig: true,
            bendAccessories: true
        });

        const meshes = await fbxMeshes(fbx);
        const handle = meshes.find((mesh) => /^handle/i.test(mesh.name));

        assert.ok(handle);
        assert.equal(handle.isSkinnedMesh, true);
        assert.ok(handle.geometry.attributes.skinIndex);
        assert.ok(handle.geometry.attributes.skinWeight);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("FBX missing metadata preserves the geometric fallback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-fbx-"));
    const obj = r15ObjWithMultiRegionHandle();

    try {
        fs.writeFileSync(path.join(dir, "avatar.obj"), obj);
        fs.writeFileSync(path.join(dir, "avatar.mtl"), "newmtl cloth\nKd 1 1 1\n");

        const fbx = await buildFbx({
            objText: obj,
            mtlText: "newmtl cloth\nKd 1 1 1\n",
            assetDir: dir,
            splitParts: true,
            groupName: "Tester",
            rig: true,
            bendAccessories: true
        });

        const meshes = await fbxMeshes(fbx);
        const handle = meshes.find((mesh) => /^handle/i.test(mesh.name));

        assert.ok(handle);
        assert.equal(handle.isSkinnedMesh, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
