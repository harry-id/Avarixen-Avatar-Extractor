"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { sweepDownloads } = require("../downloads-cleanup");

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "aae-cleanup-"));
}

test("sweepDownloads removes old entries and keeps fresh ones", () => {
    const dir = makeTempDir();
    const oldFile = path.join(dir, "old.txt");
    const freshFile = path.join(dir, "fresh.txt");

    fs.writeFileSync(oldFile, "old");
    fs.writeFileSync(freshFile, "fresh");

    // Backdate the old file by two days.
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, twoDaysAgo, twoDaysAgo);

    const result = sweepDownloads(dir, 24 * 60 * 60 * 1000);

    assert.strictEqual(result.removed, 1);
    assert.strictEqual(result.errors, 0);
    assert.strictEqual(fs.existsSync(oldFile), false);
    assert.strictEqual(fs.existsSync(freshFile), true);

    fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepDownloads removes old directories recursively", () => {
    const dir = makeTempDir();
    const userId = path.join(dir, "123456");
    fs.mkdirSync(userId);
    fs.writeFileSync(path.join(userId, "avatar.obj"), "x");

    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(userId, twoDaysAgo, twoDaysAgo);

    const result = sweepDownloads(dir, 24 * 60 * 60 * 1000);

    assert.strictEqual(result.removed, 1);
    assert.strictEqual(fs.existsSync(userId), false);

    fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepDownloads tolerates a missing directory", () => {
    const result = sweepDownloads(path.join(os.tmpdir(), "does-not-exist-aae"));

    assert.strictEqual(result.removed, 0);
    assert.strictEqual(result.errors, 0);
});