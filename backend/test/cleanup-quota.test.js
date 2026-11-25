"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { sweepDownloads, touchEntry } = require("../downloads-cleanup");

function makeEntry(dir, name, contents, ageMs) {
    const full = path.join(dir, name);
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(path.join(full, "avatar.obj"), contents);

    const time = new Date(Date.now() - ageMs);
    fs.utimesSync(full, time, time);
    return full;
}

test("sweepDownloads enforces a byte quota oldest-first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-cache-"));

    try {
        const oldDir = makeEntry(dir, "1", "x".repeat(200), 10_000);
        const newDir = makeEntry(dir, "2", "y".repeat(200), 1_000);

        const result = sweepDownloads(dir, 24 * 60 * 60 * 1000, Date.now(), {
            maxBytes: 250
        });

        assert.equal(fs.existsSync(oldDir), false);
        assert.equal(fs.existsSync(newDir), true);
        assert.equal(result.removed, 1);
        assert.ok(result.removedBytes >= 200);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("sweepDownloads skips entries that are actively in use", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-cache-"));

    try {
        const active = makeEntry(dir, "42", "active", 10_000);
        const idle = makeEntry(dir, "43", "idle", 10_000);

        const result = sweepDownloads(dir, 1, Date.now(), {
            shouldSkip: (_full, name) => name === "42"
        });

        assert.equal(fs.existsSync(active), true);
        assert.equal(fs.existsSync(idle), false);
        assert.equal(result.removed, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("sweepDownloads discards everything with a negative TTL (server clamps this)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-cache-"));

    try {
        makeEntry(dir, "1", "x", 1000);
        makeEntry(dir, "2", "y", 1000);

        const result = sweepDownloads(dir, -1, Date.now());
        assert.equal(result.removed, 2);
        assert.deepEqual(fs.readdirSync(dir), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("sweepDownloads protects entries younger than minAgeMs from quota eviction", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-cache-"));

    try {
        // Young (recently read) entry and an older idle one, both 200 bytes.
        const youngDir = makeEntry(dir, "1", "y".repeat(200), 1_000);
        const oldDir = makeEntry(dir, "2", "x".repeat(200), 10_000);

        const result = sweepDownloads(dir, 24 * 60 * 60 * 1000, Date.now(), {
            maxBytes: 250,
            minAgeMs: 5_000
        });

        // The old idle entry is evicted; the young (protected) one survives.
        assert.equal(fs.existsSync(oldDir), false);
        assert.equal(fs.existsSync(youngDir), true);
        assert.equal(result.removed, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("touchEntry is best-effort and never throws on a missing path", async () => {
    // A nonexistent path makes utimes fail; the helper must swallow it.
    await touchEntry(path.join(os.tmpdir(), "aae-does-not-exist-xyz"));
});
