"use strict";

// Worker-thread conversion: runs the full convert + serialize off the main
// thread and returns transferable data.
//
// Output paths (matching convert.js):
//   glb           -> { kind: "glb", data: ArrayBuffer }
//   gltf embedded -> { kind: "gltf", text: string }
//   gltf separate -> { kind: "gltf-separate", files: [{ name, data: ArrayBuffer }] }
//   fbx           -> { kind: "fbx", data: ArrayBuffer }
//
// The gltf-transform Document never crosses the boundary: serialization happens
// here. Errors are returned with name/message/stack/code preserved so the route
// can still map EOBJTOOLARGE -> 413 and rig failures -> 422.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { parentPort } = require("worker_threads");

const BACKEND = path.join(__dirname, "..");
const { NodeIO } = require("@gltf-transform/core");
const rig = require("../auto-rig");
const { buildFbx } = require("../fbx-exporter");

// Forward worker logs to the main thread so the file logger captures them.
function forwardConsole(level) {
    return (...args) => {
        try {
            parentPort.postMessage({
                type: "console",
                level,
                args: args.map((a) => (typeof a === "string" ? a : safeStringify(a)))
            });
        } catch {
            // never let logging break conversion
        }
    };
}

function safeStringify(value) {
    try {
        return typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        return String(value);
    }
}

console.warn = forwardConsole("warn");
console.error = forwardConsole("error");

function toTransferable(buffer) {
    // Return a standalone ArrayBuffer (transferable) copy of a Buffer/Uint8Array.
    const u8 = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

async function serializeGlb(doc) {
    const u8 = await new NodeIO().writeBinary(doc);
    return { kind: "glb", data: toTransferable(u8) };
}

async function serializeGltfEmbedded(doc) {
    const io = new NodeIO();
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aae-embed-"));
    try {
        const buffers = doc.getRoot().listBuffers();
        buffers.forEach((buf, i) => {
            if (!buf.getURI()) buf.setURI(i === 0 ? "model.bin" : `buffer${i}.bin`);
        });
        const textures = doc.getRoot().listTextures();
        textures.forEach((tex, i) => {
            if (!tex.getURI()) tex.setURI(`texture${i}.png`);
        });

        const gltfPath = path.join(tmpDir, "model.gltf");
        await io.write(gltfPath, doc);

        const json = JSON.parse(await fs.promises.readFile(gltfPath, "utf8"));

        if (json.buffers) {
            for (const buf of json.buffers) {
                if (buf.uri && !buf.uri.startsWith("data:")) {
                    const data = await fs.promises.readFile(path.join(tmpDir, buf.uri));
                    buf.uri = `data:application/octet-stream;base64,${data.toString("base64")}`;
                }
            }
        }

        if (json.images) {
            for (const img of json.images) {
                if (img.uri && !img.uri.startsWith("data:")) {
                    const data = await fs.promises.readFile(path.join(tmpDir, img.uri));
                    const ext = path.extname(img.uri).toLowerCase();
                    const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
                    img.uri = `data:${mime};base64,${data.toString("base64")}`;
                }
            }
        }

        return { kind: "gltf", text: JSON.stringify(json) };
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function serializeGltfSeparate(doc) {
    const io = new NodeIO();
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aae-sep-"));
    try {
        const buffers = doc.getRoot().listBuffers();
        buffers.forEach((buf, i) => {
            if (!buf.getURI()) buf.setURI(i === 0 ? "model.bin" : `buffer${i}.bin`);
        });
        const textures = doc.getRoot().listTextures();
        textures.forEach((tex, i) => {
            if (!tex.getURI()) tex.setURI(`texture${i}.png`);
        });

        const gltfPath = path.join(tmpDir, "model.gltf");
        await io.write(gltfPath, doc);

        const names = await fs.promises.readdir(tmpDir);
        const files = [];
        for (const name of names) {
            const data = await fs.promises.readFile(path.join(tmpDir, name));
            files.push({ name, data: toTransferable(data) });
        }
        return { kind: "gltf-separate", files };
    } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

async function convertJob(job) {
    const { fmt, assetDir, separate } = job;
    const options = job.options || {};

    if (fmt === "fbx") {
        const objText = await fs.promises.readFile(path.join(assetDir, "avatar.obj"), "utf8");
        const mtlText = await fs.promises
            .readFile(path.join(assetDir, "avatar.mtl"), "utf8")
            .catch(() => "");
        const fbx = await buildFbx({ objText, mtlText, assetDir, ...options });
        return { kind: "fbx", data: toTransferable(fbx) };
    }

    const { doc } = await rig.convertAvatar(assetDir, options);

    if (fmt === "glb") {
        return serializeGlb(doc);
    }

    if (separate) {
        return serializeGltfSeparate(doc);
    }

    return serializeGltfEmbedded(doc);
}

async function handle(job) {
    const t0 = Date.now();
    try {
        const result = await convertJob(job);
        result.ok = true;
        result.id = job.id;
        result.ms = Date.now() - t0;
        const transfer = [];
        if (result.data) transfer.push(result.data);
        if (Array.isArray(result.files)) {
            for (const f of result.files) transfer.push(f.data);
        }
        parentPort.postMessage(result, transfer);
    } catch (err) {
        parentPort.postMessage({
            ok: false,
            id: job.id,
            ms: Date.now() - t0,
            error: {
                name: err && err.name,
                message: err && err.message ? String(err.message) : String(err),
                stack: err && err.stack,
                code: err && err.code
            }
        });
    }
}

parentPort.on("message", (job) => {
    if (job && job.cmd === "stop") {
        parentPort.postMessage({ stopped: true, id: job.id });
        return;
    }
    // Test hook: simulate an unexpected worker exit so the pool can respawn.
    if (job && job.cmd === "crash") {
        process.exit(1);
        return;
    }
    // Test hook: a controllable long-running job for cancellation tests.
    if (job && job.cmd === "sleep") {
        const t0 = Date.now();
        setTimeout(() => {
            parentPort.postMessage({ ok: true, id: job.id, kind: "sleep", ms: Date.now() - t0 });
        }, job.ms || 1000);
        return;
    }
    handle(job);
});