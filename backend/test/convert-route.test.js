"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const JSZip = require("jszip");

const registerConvertRoutes = require("../convert");

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
            assert.equal(noRigBody.message, "Konversi model gagal.");

            const withRig = await fetch(
                `${base}/api/roblox/convert/${USER_ID}/fbx?rig=1`
            );
            assert.equal(withRig.status, 422);
            const withRigBody = await withRig.json();
            assert.match(withRigBody.message, /Auto-rig gagal/);

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
            assert.ok(archive.file(`${USER_ID}.gltf`));
            assert.ok(archive.file("model.bin"));
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
