"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseLogLimit, rotateLogFile } = require("../logger");

test("rotateLogFile shifts the current log and keeps N backups", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-log-"));
    const file = path.join(dir, "aae.log");

    try {
        fs.writeFileSync(file, "current");
        fs.writeFileSync(`${file}.1`, "older");
        fs.writeFileSync(`${file}.2`, "oldest");
        fs.writeFileSync(`${file}.3`, "stale");

        rotateLogFile(file, 2);

        assert.equal(fs.existsSync(file), false);
        assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "current");
        assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "older");
        assert.equal(fs.existsSync(`${file}.3`), false, "extra backup removed");

        fs.writeFileSync(file, "newer");
        rotateLogFile(file, 2);

        assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "newer");
        assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "current");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("rotateLogFile with zero keeps nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aae-log-"));
    const file = path.join(dir, "aae.log");

    try {
        fs.writeFileSync(file, "current");
        fs.writeFileSync(`${file}.1`, "older");

        rotateLogFile(file, 0);

        assert.equal(fs.existsSync(file), false);
        assert.equal(fs.existsSync(`${file}.1`), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("parseLogLimit accepts zero and rejects invalid/negative values", () => {
    assert.equal(parseLogLimit("0", 10), 0);
    assert.equal(parseLogLimit("100", 10), 100);
    assert.equal(parseLogLimit("-1", 10), 10);
    assert.equal(parseLogLimit("junk", 10), 10);
    assert.equal(parseLogLimit(undefined, 10), 10);
});
