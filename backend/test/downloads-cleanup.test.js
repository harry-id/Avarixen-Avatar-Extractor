"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { sweepDownloads, isOldBackupOfMissingOutput } = require("../downloads-cleanup");

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

test("isOldBackupOfMissingOutput detects backups whose output is gone", () => {
    const dir = makeTempDir();
    const userId = "123456";

    // No output dir -> backup of a missing output.
    assert.strictEqual(
        isOldBackupOfMissingOutput(dir, `.old-${userId}-1000`),
        true
    );

    // Output present -> not a missing-output backup.
    fs.mkdirSync(path.join(dir, userId));
    assert.strictEqual(
        isOldBackupOfMissingOutput(dir, `.old-${userId}-1000`),
        false
    );

    // Non-backup names are never flagged.
    assert.strictEqual(isOldBackupOfMissingOutput(dir, userId), false);
    assert.strictEqual(isOldBackupOfMissingOutput(dir, `.stage-${userId}-x`), false);

    fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepDownloads never deletes a backup whose output is missing when shouldSkip guards it", () => {
    const dir = makeTempDir();
    const userId = "123456";
    const backup = path.join(dir, `.old-${userId}-1000`);
    fs.mkdirSync(backup);
    fs.writeFileSync(path.join(backup, "avatar.obj"), "ONLY COPY");

    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(backup, twoDaysAgo, twoDaysAgo);

    const result = sweepDownloads(dir, 24 * 60 * 60 * 1000, Date.now(), {
        shouldSkip: (full, name) => isOldBackupOfMissingOutput(dir, name)
    });

    assert.strictEqual(result.removed, 0);
    assert.strictEqual(fs.existsSync(backup), true);

    fs.rmSync(dir, { recursive: true, force: true });
});