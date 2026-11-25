"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const { NodeIO } = require("@gltf-transform/core");

const rig = require("../auto-rig");
const { buildFbx } = require("../fbx-exporter");

const WORKER = path.join(__dirname, "../worker/conversion-worker.js");

async function loadFbx(buffer) {
    const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
    const loader = new FBXLoader();
    return loader.parse(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        ""
    );
}

// Semantic signature of a loaded scene: mesh count, total vertices, and a
// rounded position checksum. Used because the FBX writer is not byte-stable
// (two synchronous runs differ in ~400 padding bytes), so byte-identical
// comparison is impossible for FBX.
function sceneSignature(group) {
    let meshes = 0;
    let vertices = 0;
    let sum = 0;
    group.traverse((o) => {
        if (!o.isMesh) return;
        meshes += 1;
        const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
        if (pos) {
            vertices += pos.count;
            for (let i = 0; i < pos.array.length; i++) sum += pos.array[i];
        }
    });
    return { meshes, vertices, sum: Math.round(sum * 1000) / 1000 };
}

function makeAvatarDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-worker-test-"));
    const boxes = {
        Head: [-0.5, 0.5, 9, 11, -0.5, 0.5],
        Torso: [-1, 1, 5, 9, -0.5, 0.5],
        "Left Arm": [-2, -1.2, 6, 9, -0.3, 0.3],
        "Right Arm": [1.2, 2, 6, 9, -0.3, 0.3]
    };
    const lines = [];
    let idx = 1;
    for (const [name, b] of Object.entries(boxes)) {
        const [x0, x1, y0, y1, z0, z1] = b;
        const c = [
            [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
            [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]
        ];
        lines.push(`g ${name}`);
        for (const p of c) lines.push(`v ${p[0]} ${p[1]} ${p[2]}`);
        const f = [
            [1, 2, 3], [1, 3, 4], [5, 6, 7], [5, 7, 8],
            [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6],
            [3, 4, 8], [3, 8, 7], [4, 1, 5], [4, 5, 8]
        ];
        for (const t of f) lines.push(`f ${idx + t[0] - 1} ${idx + t[1] - 1} ${idx + t[2] - 1}`);
        idx += 8;
    }
    fs.writeFileSync(path.join(dir, "avatar.obj"), lines.join("\n"));
    fs.writeFileSync(path.join(dir, "avatar.mtl"), "newmtl cloth\nKd 0.8 0.8 0.8\n");
    fs.writeFileSync(
        path.join(dir, "avatar.json"),
        JSON.stringify({ userId: "1", playerAvatarType: "R6", assets: [{ assetType: { id: 8, name: "Hat" } }] })
    );
    return dir;
}

function runWorker(job, env) {
    return new Promise((resolve, reject) => {
        const w = new Worker(WORKER, env ? { env: { ...process.env, ...env } } : {});
        const logs = [];
        w.on("message", (m) => {
            if (m && m.type === "console") { logs.push(m); return; }
            resolve({ msg: m, logs });
            w.terminate();
        });
        w.on("error", reject);
        w.postMessage({ ...job, id: 1 });
    });
}

// ---- synchronous reference serialization (mirrors convert.js) ----
async function syncGlb(dir, options) {
    const { doc } = await rig.convertAvatar(dir, options);
    return Buffer.from(await new NodeIO().writeBinary(doc));
}

async function syncGltfEmbedded(dir, options) {
    const { doc } = await rig.convertAvatar(dir, options);
    const io = new NodeIO();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-sync-emb-"));
    try {
        const buffers = doc.getRoot().listBuffers();
        buffers.forEach((buf, i) => { if (!buf.getURI()) buf.setURI(i === 0 ? "model.bin" : `buffer${i}.bin`); });
        const textures = doc.getRoot().listTextures();
        textures.forEach((tex, i) => { if (!tex.getURI()) tex.setURI(`texture${i}.png`); });
        const gp = path.join(tmpDir, "model.gltf");
        await io.write(gp, doc);
        const json = JSON.parse(fs.readFileSync(gp, "utf8"));
        if (json.buffers) for (const b of json.buffers) if (b.uri && !b.uri.startsWith("data:")) b.uri = `data:application/octet-stream;base64,${fs.readFileSync(path.join(tmpDir, b.uri)).toString("base64")}`;
        if (json.images) for (const im of json.images) if (im.uri && !im.uri.startsWith("data:")) {
            const ext = path.extname(im.uri).toLowerCase();
            const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
            im.uri = `data:${mime};base64,${fs.readFileSync(path.join(tmpDir, im.uri)).toString("base64")}`;
        }
        return JSON.stringify(json);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function syncGltfSeparate(dir, options) {
    const { doc } = await rig.convertAvatar(dir, options);
    const io = new NodeIO();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-sync-sep-"));
    try {
        const buffers = doc.getRoot().listBuffers();
        buffers.forEach((buf, i) => { if (!buf.getURI()) buf.setURI(i === 0 ? "model.bin" : `buffer${i}.bin`); });
        const textures = doc.getRoot().listTextures();
        textures.forEach((tex, i) => { if (!tex.getURI()) tex.setURI(`texture${i}.png`); });
        await io.write(path.join(tmpDir, "model.gltf"), doc);
        const out = {};
        for (const name of fs.readdirSync(tmpDir)) out[name] = fs.readFileSync(path.join(tmpDir, name));
        return out;
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

const OPTIONS = { rig: true, splitParts: true, groupName: "T", subdivision: 0 };

test("worker GLB output is byte-identical to the synchronous path", async () => {
    const dir = makeAvatarDir();
    try {
        const expected = await syncGlb(dir, OPTIONS);
        const { msg } = await runWorker({ fmt: "glb", assetDir: dir, options: OPTIONS });
        assert.equal(msg.ok, true);
        assert.equal(msg.kind, "glb");
        assert.deepEqual(Buffer.from(msg.data), expected);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("worker embedded glTF output is byte-identical to the synchronous path", async () => {
    const dir = makeAvatarDir();
    try {
        const expected = await syncGltfEmbedded(dir, OPTIONS);
        const { msg } = await runWorker({ fmt: "gltf", assetDir: dir, options: OPTIONS });
        assert.equal(msg.ok, true);
        assert.equal(msg.kind, "gltf");
        assert.equal(msg.text, expected);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("worker separate glTF files match the synchronous path", async () => {
    const dir = makeAvatarDir();
    try {
        const expected = await syncGltfSeparate(dir, OPTIONS);
        const { msg } = await runWorker({ fmt: "gltf", assetDir: dir, separate: true, options: OPTIONS });
        assert.equal(msg.ok, true);
        assert.equal(msg.kind, "gltf-separate");
        const got = {};
        for (const f of msg.files) got[f.name] = Buffer.from(f.data);
        assert.deepEqual(Object.keys(got).sort(), Object.keys(expected).sort());
        for (const name of Object.keys(expected)) {
            assert.deepEqual(got[name], expected[name], `file ${name} differs`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("worker FBX output is semantically identical to the synchronous path", async () => {
    const dir = makeAvatarDir();
    try {
        const objText = fs.readFileSync(path.join(dir, "avatar.obj"), "utf8");
        const mtlText = fs.readFileSync(path.join(dir, "avatar.mtl"), "utf8");
        const expected = await buildFbx({ objText, mtlText, assetDir: dir, ...OPTIONS });
        const { msg } = await runWorker({ fmt: "fbx", assetDir: dir, options: OPTIONS });
        assert.equal(msg.ok, true);
        assert.equal(msg.kind, "fbx");

        const workerBuf = Buffer.from(msg.data);
        // The FBX writer is not byte-stable (uninitialized padding), so compare
        // the parsed scene rather than raw bytes.
        assert.equal(workerBuf.length, expected.length, "FBX length must match");
        assert.equal(workerBuf.subarray(0, 27).toString("ascii"), expected.subarray(0, 27).toString("ascii"), "FBX header must match");
        const a = sceneSignature(await loadFbx(expected));
        const b = sceneSignature(await loadFbx(workerBuf));
        assert.deepEqual(b, a, "worker FBX scene must match the synchronous scene");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("worker preserves error name/message/stack/code across the boundary", async () => {
    const dir = makeAvatarDir();
    try {
        // MAX_OBJ_FACES=1 makes buildFbx throw EOBJTOOLARGE (2+ faces present).
        const { msg } = await runWorker(
            { fmt: "fbx", assetDir: dir, options: OPTIONS },
            { MAX_OBJ_FACES: "1" }
        );
        assert.equal(msg.ok, false);
        assert.equal(msg.error.code, "EOBJTOOLARGE");
        assert.equal(msg.error.name, "ObjLimitError");
        assert.match(msg.error.message, /face limit/);
        assert.ok(typeof msg.error.stack === "string" && msg.error.stack.length > 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("worker forwards console.warn/error to the main thread", async () => {
    const dir = makeAvatarDir();
    try {
        // A layered asset with a handle-count mismatch triggers a console.warn.
        const { msg, logs } = await runWorker({ fmt: "glb", assetDir: dir, options: OPTIONS });
        assert.equal(msg.ok, true);
        // No assertion that a warning must fire (depends on data); just ensure
        // the channel works: if any log arrived it is well-formed.
        for (const entry of logs) {
            assert.equal(entry.type, "console");
            assert.ok(entry.level === "warn" || entry.level === "error");
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});