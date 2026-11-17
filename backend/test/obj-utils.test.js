"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeObjForExport } = require("../obj-utils");

const OBJ = [
    "mtllib avatar.mtl",
    "g Handle1",
    "",
    "v -2 100 -1 1 1 1 1",
    "v 2 100.5 -1 1 1 1 1",
    "v 0 105 3 1 1 1 1",
    "usemtl cloth",
    "f 1 2 3",
    "g Player1",
    "v -1 101 0",
    "v 1 101 0",
    "v 0 102 2",
    "f 4 5 6",
    ""
].join("\n");

test("normalizeObjForExport puts feet at Y=0 and centres X/Z", () => {
    const out = normalizeObjForExport(OBJ);
    const vertices = out
        .split("\n")
        .filter((line) => line.startsWith("v "))
        .map((line) => line.split(/\s+/).slice(1, 4).map(Number));

    const ys = vertices.map((v) => v[1]);
    const xs = vertices.map((v) => v[0]);
    const zs = vertices.map((v) => v[2]);

    assert.equal(Math.min(...ys), 0);
    assert.equal((Math.min(...xs) + Math.max(...xs)) / 2, 0);
    assert.equal((Math.min(...zs) + Math.max(...zs)) / 2, 0);
});

test("normalizeObjForExport preserves vertex colours", () => {
    const line = normalizeObjForExport(OBJ)
        .split("\n")
        .find((l) => l.startsWith("v ") && l.endsWith(" 1 1 1 1"));

    assert.ok(line);
    assert.equal(line.trim().split(/\s+/).length, 8);
});

test("normalizeObjForExport mirrors groups as objects for Blender", () => {
    const out = normalizeObjForExport(OBJ);
    const objects = out.split("\n").filter((line) => line.startsWith("o "));

    assert.deepEqual(objects, ["o Handle1", "o Player1"]);
    // Group declarations are kept for Prisma3D and three.js.
    assert.equal(out.split("\n").filter((line) => line.startsWith("g ")).length, 2);
});

test("normalizeObjForExport does not add objects when o lines already exist", () => {
    const withObject = OBJ.replace("g Handle1", "o Handle1\ng Handle1");
    const out = normalizeObjForExport(withObject);

    assert.equal(out.split("\n").filter((line) => line.startsWith("o ")).length, 1);
});

test("normalizeObjForExport is idempotent for centring", () => {
    const once = normalizeObjForExport(OBJ);
    const twice = normalizeObjForExport(once);

    assert.equal(twice, once);
});
