"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { planTextures, isValidAssetHash, recoverDownloads } = require("../avatar-downloader");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("planTextures names successful textures contiguously", () => {
    const hashes = ["hash1", "hash2", "hash3"];
    const buffers = [Buffer.from("a"), null, Buffer.from("c")];
    const mtl = [
        "newmtl one",
        "map_Kd hash1",
        "newmtl two",
        "map_Kd hash2",
        "newmtl three",
        "map_Kd hash3",
        ""
    ].join("\n");

    const plan = planTextures(hashes, buffers, mtl);

    assert.deepEqual(plan.textures.map((t) => t.filename), ["texture1.png", "texture2.png"]);
    assert.deepEqual(plan.missing, ["hash2"]);

    // No gaps: the texture after the failure becomes texture2.png.
    assert.match(plan.mtl, /map_Kd texture1\.png/);
    assert.match(plan.mtl, /map_Kd texture2\.png/);
    assert.doesNotMatch(plan.mtl, /hash1|hash2|hash3/);
});

test("planTextures keeps all names when every download succeeds", () => {
    const hashes = ["a", "b"];
    const buffers = [Buffer.from("1"), Buffer.from("2")];
    const mtl = "newmtl m\nmap_Kd a\n";

    const plan = planTextures(hashes, buffers, mtl);

    assert.deepEqual(plan.textures.map((t) => t.filename), ["texture1.png", "texture2.png"]);
    assert.deepEqual(plan.missing, []);
    assert.equal(plan.mtl, "newmtl m\nmap_Kd texture1.png\n");
});

test("planTextures rewrites every reference to the same hash", () => {
    const hash = "30DAY-abc123";
    const mtl = [
        "newmtl m1",
        "map_Ka " + hash,
        "map_Kd " + hash,
        "map_d " + hash,
        "newmtl m2",
        "map_Ka " + hash,
        ""
    ].join("\n");

    const plan = planTextures([hash], [Buffer.from("x")], mtl);

    assert.doesNotMatch(plan.mtl, /30DAY-abc123/);
    assert.equal((plan.mtl.match(/texture1\.png/g) || []).length, 4);
});

test("isValidAssetHash accepts real and fixture hash formats", () => {
    // Real cached metadata hashes: "30DAY-<32 hex>".
    assert.equal(
        isValidAssetHash("30DAY-0438af40ad8fbfe9e943c683a325b59d"),
        true
    );
    assert.equal(isValidAssetHash("0438af40ad8fbfe9e943c683a325b59d"), true);
    // Existing test fixtures use short URL-safe tokens.
    assert.equal(isValidAssetHash("hash1"), true);
    assert.equal(isValidAssetHash("objhash"), true);
    assert.equal(isValidAssetHash("a_b-c"), true);
});

test("isValidAssetHash rejects separators, query characters, and malformed input", () => {
    const bad = [
        "",
        "../x",
        "a/b",
        "a?b",
        "a#b",
        "a.b",
        "a b",
        "x".repeat(129),
        null,
        undefined,
        123
    ];

    for (const value of bad) {
        assert.equal(isValidAssetHash(value), false, String(value));
    }
});

// ---- Startup backup recovery (recoverDownloads) ----

function makeDownloadsRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "aae-recover-"));
}

test("recoverDownloads restores output from .old-* after a crash between renames", () => {
    const root = makeDownloadsRoot();
    const userId = "12345";
    try {
        // Simulate: output was renamed to .old-<ts>, staging still exists, and
        // the process crashed before staging -> output.
        const backup = path.join(root, `.old-${userId}-${Date.now()}`);
        fs.mkdirSync(backup, { recursive: true });
        fs.writeFileSync(path.join(backup, "avatar.obj"), "GOOD OBJ");
        fs.writeFileSync(path.join(backup, "avatar.mtl"), "GOOD MTL");
        const stage = path.join(root, `.stage-${userId}-abc`);
        fs.mkdirSync(stage, { recursive: true });
        fs.writeFileSync(path.join(stage, "avatar.obj"), "PARTIAL");

        const result = recoverDownloads(root, { log: () => {} });

        const output = path.join(root, userId);
        assert.equal(fs.readFileSync(path.join(output, "avatar.obj"), "utf8"), "GOOD OBJ");
        assert.equal(fs.readFileSync(path.join(output, "avatar.mtl"), "utf8"), "GOOD MTL");
        assert.ok(result.restored.includes(userId));
        assert.equal(fs.existsSync(backup), false, "backup renamed back to output");
        assert.equal(fs.existsSync(stage), false, "stale stage dir removed");
        assert.deepEqual(result.removedStages, [".stage-" + userId + "-abc"]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("recoverDownloads leaves .old-* alone when output is present", () => {
    const root = makeDownloadsRoot();
    const userId = "12345";
    try {
        const output = path.join(root, userId);
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, "avatar.obj"), "LIVE");
        const backup = path.join(root, `.old-${userId}-1000`);
        fs.mkdirSync(backup, { recursive: true });
        fs.writeFileSync(path.join(backup, "avatar.obj"), "OLD");

        const result = recoverDownloads(root, { log: () => {} });

        assert.equal(fs.readFileSync(path.join(output, "avatar.obj"), "utf8"), "LIVE");
        assert.equal(fs.existsSync(backup), true, "backup left for the normal sweep");
        assert.deepEqual(result.restored, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("recoverDownloads restores the newest backup when several exist", () => {
    const root = makeDownloadsRoot();
    const userId = "12345";
    try {
        const older = path.join(root, `.old-${userId}-1000`);
        const newer = path.join(root, `.old-${userId}-2000`);
        fs.mkdirSync(older, { recursive: true });
        fs.writeFileSync(path.join(older, "avatar.obj"), "OLDER");
        fs.mkdirSync(newer, { recursive: true });
        fs.writeFileSync(path.join(newer, "avatar.obj"), "NEWER");

        const result = recoverDownloads(root, { log: () => {} });

        const output = path.join(root, userId);
        assert.equal(fs.readFileSync(path.join(output, "avatar.obj"), "utf8"), "NEWER");
        assert.deepEqual(result.restored, [userId]);
        assert.equal(fs.existsSync(newer), false, "newest renamed to output");
        assert.equal(fs.existsSync(older), true, "older backup left for normal sweep");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("recoverDownloads is idempotent", () => {
    const root = makeDownloadsRoot();
    const userId = "12345";
    try {
        const backup = path.join(root, `.old-${userId}-1000`);
        fs.mkdirSync(backup, { recursive: true });
        fs.writeFileSync(path.join(backup, "avatar.obj"), "GOOD");

        const first = recoverDownloads(root, { log: () => {} });
        assert.deepEqual(first.restored, [userId]);

        // Second run: output now present, nothing to do.
        const second = recoverDownloads(root, { log: () => {} });
        assert.deepEqual(second.restored, []);
        assert.deepEqual(second.removedStages, []);
        assert.equal(second.errors, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("recoverDownloads never throws on a bad root (does not block startup)", () => {
    const root = makeDownloadsRoot();
    try {
        // A regular file where a directory is expected -> readdir fails (ENOTDIR).
        const filePath = path.join(root, "not-a-dir");
        fs.writeFileSync(filePath, "x");

        let result;
        assert.doesNotThrow(() => {
            result = recoverDownloads(filePath, { log: () => {} });
        });
        assert.ok(result.errors >= 1, "error counted but not thrown");

        // A missing root is ignored (ENOENT), not an error.
        const missing = recoverDownloads(path.join(root, "nope"), { log: () => {} });
        assert.equal(missing.errors, 0);
        assert.deepEqual(missing.restored, []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
