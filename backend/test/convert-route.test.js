"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const JSZip = require("jszip");
const { PNG } = require("pngjs");

const registerConvertRoutes = require("../convert");
const { withUserLock } = require("../user-lock");

const USER_ID = String(9_910_000_000 + Math.floor(Math.random() * 100000));
const DOWNLOADS_DIR = path.join(__dirname, "../../downloads");
const USER_DIR = path.join(DOWNLOADS_DIR, USER_ID);

async function withServer(run, options = {}) {
    const app = express();
    registerConvertRoutes(app, options);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));

    try {
        await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
}

test("non-rigged conversion failures are 500, rig failures are 422", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), "# OBJ with no faces\n");
    await fs.writeFile(path.join(USER_DIR, "avatar.mtl"), "");

    try {
        await withServer(async (base) => {
            const noRig = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/fbx`
            );
            assert.equal(noRig.status, 500);
            const noRigBody = await noRig.json();
            assert.equal(noRigBody.message, "Model conversion failed.");

            const withRig = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/fbx?rig=1`
            );
            assert.equal(withRig.status, 422);
            const withRigBody = await withRig.json();
            assert.match(withRigBody.message, /Auto-rig failed/);

            const head = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/fbx`,
                { method: "HEAD" }
            );
            assert.equal(head.status, 405);
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("conversion streams GLB and separate GLTF ZIP responses", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), [
        "g Torso",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        ""
    ].join("\n"));
    await fs.writeFile(path.join(USER_DIR, "avatar.mtl"), "");

    try {
        await withServer(async (base) => {
            const glb = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/glb`
            );
            assert.equal(glb.status, 200);
            const glbBody = Buffer.from(await glb.arrayBuffer());
            assert.equal(glbBody.subarray(0, 4).toString("ascii"), "glTF");
            assert.ok(glbBody.length > 20);

            const zipped = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/gltf?separate=1`
            );
            assert.equal(zipped.status, 200);
            assert.equal(zipped.headers.get("content-type"), "application/zip");

            const archive = await JSZip.loadAsync(
                Buffer.from(await zipped.arrayBuffer())
            );
            assert.deepEqual(
                Object.keys(archive.files).sort(),
                [`${USER_ID}.gltf`, "model.bin"].sort()
            );
            const gltfEntry = await archive.file(`${USER_ID}.gltf`).async("nodebuffer");
            assert.ok(gltfEntry.length > 0);
            const binEntry = await archive.file("model.bin").async("nodebuffer");
            assert.ok(binEntry.length > 0);
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("parts queue overflow returns 503", async () => {
    const { createAdmissionLimiter } = require("../admission-limiter");
    const limiter = createAdmissionLimiter({
        maxConcurrent: 1,
        maxQueue: 0,
        code: "EPARTSBUSY"
    });
    const release = await limiter.acquire();

    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), [
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        ""
    ].join("\n"));

    try {
        await withServer(async (base) => {
            const response = await fetch(
                `${base}/api/roblox/parts/${USER_ID}`
            );
            assert.equal(response.status, 503);
            assert.equal(response.headers.get("retry-after"), "5");
        }, { partsLimiter: limiter });
    } finally {
        release();
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("oversized OBJ is rejected with 413 by parts and convert", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), [
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        ""
    ].join("\n"));
    await fs.writeFile(path.join(USER_DIR, "avatar.mtl"), "");

    const previous = process.env.MAX_OBJ_BYTES;
    process.env.MAX_OBJ_BYTES = "8";

    try {
        await withServer(async (base) => {
            const parts = await fetch(`${base}/api/roblox/parts/${USER_ID}`);
            assert.equal(parts.status, 413);

            const convert = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/glb`
            );
            assert.equal(convert.status, 413);
        });
    } finally {
        if (previous === undefined) delete process.env.MAX_OBJ_BYTES;
        else process.env.MAX_OBJ_BYTES = previous;
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("GLB binary container structure is valid", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), [
        "g Torso",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        ""
    ].join("\n"));
    await fs.writeFile(path.join(USER_DIR, "avatar.mtl"), "");

    try {
        await withServer(async (base) => {
            const res = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/glb`
            );
            assert.equal(res.status, 200);
            const buf = Buffer.from(await res.arrayBuffer());

            // GLB header: magic "glTF", version 2, total file length.
            assert.equal(buf.subarray(0, 4).toString("ascii"), "glTF");
            assert.equal(buf.readUInt32LE(4), 2);
            assert.equal(buf.readUInt32LE(8), buf.length);

            // Walk chunks: first JSON, then BIN (GLB always embeds a BIN chunk).
            let offset = 12;
            const chunks = [];
            while (offset < buf.length) {
                const length = buf.readUInt32LE(offset);
                const type = buf.toString("ascii", offset + 4, offset + 8);
                const dataStart = offset + 8;
                const dataEnd = dataStart + length;
                assert.ok(dataEnd <= buf.length, "chunk data must stay within the GLB file");
                chunks.push({ type, data: buf.subarray(dataStart, dataEnd) });
                offset = dataEnd + ((4 - (length % 4)) % 4);
            }

            assert.equal(chunks.length, 2);
            assert.equal(chunks[0].type, "JSON");

            const json = JSON.parse(chunks[0].data.toString("utf8"));
            assert.ok(Array.isArray(json.buffers));

            assert.equal(chunks[1].type, "BIN\x00");
            const binChunk = chunks[1];
            const jsonBuffer = json.buffers[0];
            assert.ok(jsonBuffer);
            assert.equal(jsonBuffer.uri, undefined);
            assert.equal(typeof jsonBuffer.byteLength, "number");
            assert.ok(binChunk.data.length >= jsonBuffer.byteLength);
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("GLTF embedded export response is valid JSON with embedded resources", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), [
        "g Torso",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        ""
    ].join("\n"));
    await fs.writeFile(path.join(USER_DIR, "avatar.mtl"), "");

    try {
        await withServer(async (base) => {
            const res = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/gltf`
            );
            assert.equal(res.status, 200);
            assert.match(
                res.headers.get("content-type") || "",
                /model\/gltf\+json/
            );

            const gltfText = await res.text();
            const json = JSON.parse(gltfText);

            assert.equal(json.asset && json.asset.version, "2.0");

            assert.ok(Array.isArray(json.buffers));
            const buffer = json.buffers[0];
            assert.ok(buffer);
            assert.equal(typeof buffer.uri, "string");
            assert.ok(buffer.uri.startsWith("data:"));
            const decodedBuffer = Buffer.from(
                buffer.uri.split(",")[1],
                "base64"
            );
            assert.equal(decodedBuffer.length, buffer.byteLength);

            if (Array.isArray(json.images)) {
                for (const image of json.images) {
                    if (!image || !image.uri) {
                        continue;
                    }
                    assert.ok(image.uri.startsWith("data:"));
                    const decodedImage = Buffer.from(
                        image.uri.split(",")[1],
                        "base64"
                    );
                    assert.equal(
                        decodedImage.subarray(0, 8).toString("hex"),
                        "89504e470d0a1a0a",
                        "embedded image should be a PNG"
                    );
                }
            }
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("GLB export streams a single embedded binary regardless of separate", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), [
        "g Torso",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        ""
    ].join("\n"));
    await fs.writeFile(path.join(USER_DIR, "avatar.mtl"), "");

    try {
        await withServer(async (base) => {
            const res = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/glb`
            );
            assert.equal(res.status, 200);
            assert.equal(res.headers.get("content-type"), "model/gltf-binary");
            assert.ok(
                (res.headers.get("content-disposition") || "").includes(`${USER_ID}.glb`)
            );
            const buf = Buffer.from(await res.arrayBuffer());
            assert.equal(buf.subarray(0, 4).toString("ascii"), "glTF");

            const separateRes = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/glb?separate=1`
            );
            assert.equal(separateRes.status, 200);
            assert.equal(separateRes.headers.get("content-type"), "model/gltf-binary");
            assert.ok(
                (separateRes.headers.get("content-disposition") || "").includes(`${USER_ID}.glb`)
            );
            const separateBuf = Buffer.from(await separateRes.arrayBuffer());
            assert.equal(separateBuf.subarray(0, 4).toString("ascii"), "glTF");
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("FBX separate export streams a ZIP containing the FBX and textures", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), [
        "g Torso",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        ""
    ].join("\n"));
    await fs.writeFile(path.join(USER_DIR, "avatar.mtl"), "");
    const png = new PNG({ width: 1, height: 1 });
    png.data.fill(255);
    await fs.writeFile(path.join(USER_DIR, "texture1.png"), PNG.sync.write(png));

    try {
        await withServer(async (base) => {
            const single = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/fbx`
            );
            assert.equal(single.status, 200);
            assert.equal(single.headers.get("content-type"), "application/octet-stream");
            assert.ok(
                (single.headers.get("content-disposition") || "").includes(`${USER_ID}.fbx`)
            );

            const separate = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/fbx?separate=1`
            );
            assert.equal(separate.status, 200);
            assert.equal(separate.headers.get("content-type"), "application/zip");
            assert.ok(
                (separate.headers.get("content-disposition") || "").includes(`${USER_ID}.zip`)
            );

            const archive = await JSZip.loadAsync(Buffer.from(await separate.arrayBuffer()));
            assert.deepEqual(
                Object.keys(archive.files).sort(),
                [`${USER_ID}.fbx`, "texture1.png"].sort()
            );

            const fbxBuffer = await archive.file(`${USER_ID}.fbx`).async("nodebuffer");
            assert.ok(fbxBuffer.length > 0);
            const textureBuffer = await archive.file("texture1.png").async("nodebuffer");
            const textureFixture = await fs.readFile(path.join(USER_DIR, "texture1.png"));
            assert.ok(textureBuffer.equals(textureFixture));
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("compat=1 aliases separate=1 for GLTF and FBX exports", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), [
        "g Torso",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        ""
    ].join("\n"));
    await fs.writeFile(path.join(USER_DIR, "avatar.mtl"), "");
    const png = new PNG({ width: 1, height: 1 });
    png.data.fill(255);
    await fs.writeFile(path.join(USER_DIR, "texture1.png"), PNG.sync.write(png));

    try {
        await withServer(async (base) => {
            const gltfCompat = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/gltf?compat=1`
            );
            const gltfSeparate = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/gltf?separate=1`
            );
            assert.equal(gltfCompat.status, gltfSeparate.status);
            assert.equal(
                gltfCompat.headers.get("content-type"),
                gltfSeparate.headers.get("content-type")
            );
            assert.equal(
                gltfCompat.headers.get("content-disposition"),
                gltfSeparate.headers.get("content-disposition")
            );

            const gltfCompatArchive = await JSZip.loadAsync(Buffer.from(await gltfCompat.arrayBuffer()));
            const gltfSeparateArchive = await JSZip.loadAsync(Buffer.from(await gltfSeparate.arrayBuffer()));
            assert.deepEqual(
                Object.keys(gltfCompatArchive.files).sort(),
                Object.keys(gltfSeparateArchive.files).sort()
            );

            const compatGltf = await gltfCompatArchive.file(`${USER_ID}.gltf`).async("nodebuffer");
            const separateGltf = await gltfSeparateArchive.file(`${USER_ID}.gltf`).async("nodebuffer");
            assert.ok(compatGltf.equals(separateGltf));

            const compatBin = await gltfCompatArchive.file("model.bin").async("nodebuffer");
            const separateBin = await gltfSeparateArchive.file("model.bin").async("nodebuffer");
            assert.ok(compatBin.equals(separateBin));

            const fbxCompat = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/fbx?compat=1`
            );
            const fbxSeparate = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/fbx?separate=1`
            );
            assert.equal(fbxCompat.status, fbxSeparate.status);
            assert.equal(fbxCompat.headers.get("content-type"), fbxSeparate.headers.get("content-type"));
            assert.equal(fbxCompat.headers.get("content-disposition"), fbxSeparate.headers.get("content-disposition"));

            const fbxCompatArchive = await JSZip.loadAsync(Buffer.from(await fbxCompat.arrayBuffer()));
            const fbxSeparateArchive = await JSZip.loadAsync(Buffer.from(await fbxSeparate.arrayBuffer()));
            assert.deepEqual(
                Object.keys(fbxCompatArchive.files).sort(),
                Object.keys(fbxSeparateArchive.files).sort()
            );

            // The FBX binary embeds run-varying metadata, so byte-equality
            // across two independent conversions is not a valid contract; the
            // extracted entry contents that must match are the texture assets.
            const compatTexture = await fbxCompatArchive.file("texture1.png").async("nodebuffer");
            const separateTexture = await fbxSeparateArchive.file("texture1.png").async("nodebuffer");
            assert.ok(compatTexture.equals(separateTexture));
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("compat=1 does not change GLB into a ZIP", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), [
        "g Torso",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "f 1 2 3",
        ""
    ].join("\n"));
    await fs.writeFile(path.join(USER_DIR, "avatar.mtl"), "");

    try {
        await withServer(async (base) => {
            const res = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/glb?compat=1`
            );
            assert.equal(res.status, 200);
            assert.equal(res.headers.get("content-type"), "model/gltf-binary");
            const buf = Buffer.from(await res.arrayBuffer());
            assert.equal(buf.subarray(0, 4).toString("ascii"), "glTF");
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("GLB rig failure returns 422", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(path.join(USER_DIR, "avatar.obj"), "# OBJ with no faces\n");
    await fs.writeFile(path.join(USER_DIR, "avatar.mtl"), "");

    try {
        await withServer(async (base) => {
            const res = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/glb?rig=1`
            );
            assert.equal(res.status, 422);
            const body = await res.json();
            assert.match(body.message, /Auto-rig failed/);
        });
    } finally {
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});

test("parts waits for the same-user lock and then succeeds", async () => {
    await fs.mkdir(USER_DIR, { recursive: true });
    await fs.writeFile(
        path.join(USER_DIR, "avatar.obj"),
        ["g Torso", "v 0 0 0", "v 1 0 0", "v 0 1 0", "f 1 2 3", ""].join("\n")
    );
    await fs.writeFile(path.join(USER_DIR, "avatar.mtl"), "");

    let releaseLock;
    const held = withUserLock(
        USER_ID,
        () => new Promise((resolve) => { releaseLock = resolve; })
    );

    try {
        await withServer(async (base) => {
            let settled = false;
            const request = fetch(`${base}/api/roblox/parts/${USER_ID}`).then(
                (response) => {
                    settled = true;
                    return response;
                }
            );

            // The route must block on the lock rather than read mid-swap.
            await new Promise((resolve) => setTimeout(resolve, 150));
            assert.equal(settled, false, "parts must wait for the user lock");

            releaseLock();
            const response = await request;
            assert.equal(response.status, 200);

            const body = await response.json();
            assert.equal(body.success, true);
            assert.ok(Array.isArray(body.groups));
        });
    } finally {
        if (releaseLock) releaseLock();
        await held.catch(() => {});
        await fs.rm(USER_DIR, { recursive: true, force: true });
    }
});
