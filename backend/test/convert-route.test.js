"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const express = require("express");

const registerConvertRoutes = require("../convert");

const USER_ID = String(9_910_000_000 + Math.floor(Math.random() * 100000));
const DOWNLOADS_DIR = path.join(__dirname, "../../downloads");
const USER_DIR = path.join(DOWNLOADS_DIR, USER_ID);

async function withServer(run) {
    const app = express();
    registerConvertRoutes(app);
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
