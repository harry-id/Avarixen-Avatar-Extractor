"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeObjForExport, renameObjGroups } = require("../obj-utils");

const OBJ = [
    "mtllib avatar.mtl",
    "g Handle1",
    "",
    "v -2 103 -1 1 1 1 1",
    "v 2 103.5 -1 1 1 1 1",
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

function vertexLines(text) {
    return text
        .split("\n")
        .filter((line) => line.startsWith("v "))
        .map((line) => line.split(/\s+/).slice(1, 4).map(Number));
}

test("normalizeObjForExport puts feet at Y=0 and centres the body on X/Z", () => {
    const out = normalizeObjForExport(OBJ);
    const bodyVertices = vertexLines(out).slice(3);

    const ys = bodyVertices.map((v) => v[1]);
    const xs = bodyVertices.map((v) => v[0]);
    const zs = bodyVertices.map((v) => v[2]);

    assert.equal(Math.min(...ys), 0);
    assert.equal((Math.min(...xs) + Math.max(...xs)) / 2, 0);
    assert.equal((Math.min(...zs) + Math.max(...zs)) / 2, 0);
});

test("normalizeObjForExport ignores accessories when centring", () => {
    const withSword = [
        "g Player1",
        "v -1 10 0",
        "v 1 10 0",
        "v 0 12 2",
        "g Handle1",
        "v 0 12 100",
        "v 1 12 100",
        "v 0 13 101",
        ""
    ].join("\n");

    const out = normalizeObjForExport(withSword);
    const body = vertexLines(out).slice(0, 3);
    const zs = body.map((v) => v[2]);

    // The sword at z=100 must not pull the body away from the origin.
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

test("renameObjGroups renames g and o declarations but not handles", () => {
    const out = renameObjGroups(normalizeObjForExport(OBJ), { Player1: "Torso" });

    assert.match(out, /^o Torso$/m);
    assert.match(out, /^g Torso$/m);
    assert.match(out, /^g Handle1$/m);
    assert.match(out, /^o Handle1$/m);
    assert.doesNotMatch(out, /^[go] Player1$/m);
});

test("final normalized and renamed OBJ artifact is structurally consistent", () => {
    const finalArtifact = renameObjGroups(
        normalizeObjForExport([
            "mtllib avatar.mtl",
            "newmtl cloth",
            "map_Kd texture1.png",
            "g Player1",
            "v -1 101 0 0 0 0 0",
            "v 1 101 0 0 0 0 0",
            "v 0 102 2 0 0 0 0",
            "vt 0 0",
            "vt 1 0",
            "vt 0 1",
            "vn 0 0 1",
            "usemtl cloth",
            "f 1/1/1 2/2/1 3/3/1",
            ""
        ].join("\n")),
        { Player1: "Torso" }
    );

    const lines = finalArtifact.split("\n");
    const vertexLines = lines.filter((line) => line.startsWith("v "));
    const faces = lines.filter((line) => line.startsWith("f "));
    const objects = lines.filter((line) => line.startsWith("o "));
    const mtllibLine = lines.find((line) => line.startsWith("mtllib "));
    const newmtlLine = lines.find((line) => line.startsWith("newmtl "));
    const mapKdLine = lines.find((line) => line.startsWith("map_Kd "));
    const usemtlLine = lines.find((line) => line.startsWith("usemtl "));

    // 1. Vertex records are valid, parseable numeric records.
    assert.equal(vertexLines.length, 3);
    for (const line of vertexLines) {
        const parts = line.trim().split(/\s+/);
        assert.ok(parts.length >= 4, "vertex record must carry position plus optional values");
        for (const coord of parts.slice(1, 4)) {
            assert.ok(Number.isFinite(Number(coord)), `vertex coordinate must be numeric: ${coord}`);
        }
    }

    // 2-3. Face vertex, UV, and normal indices resolve to existing records.
    assert.equal(faces.length, 1);
    const refs = faces[0].trim().split(/\s+/).slice(1);
    const vertexCount = vertexLines.length;
    const uvCount = lines.filter((line) => line.startsWith("vt ")).length;
    const normalCount = lines.filter((line) => line.startsWith("vn ")).length;

    for (const ref of refs) {
        const [vertexIndex, uvIndex, normalIndex] = ref.split("/").map(Number);
        assert.ok(vertexIndex >= 1 && vertexIndex <= vertexCount, `face vertex index resolves: ${vertexIndex}`);
        assert.ok(uvIndex >= 1 && uvIndex <= uvCount, `face uv index resolves: ${uvIndex}`);
        assert.ok(normalIndex >= 1 && normalIndex <= normalCount, `face normal index resolves: ${normalIndex}`);
    }

    // 5. Face indices remain valid after normalization and renaming.
    assert.deepEqual(refs, ["1/1/1", "2/2/1", "3/3/1"]);

    // 6. Object/group names remain consistent after renaming.
    assert.deepEqual(objects, ["o Torso"]);

    // 7-8. MTL references and texture paths remain consistent.
    assert.equal(mtllibLine, "mtllib avatar.mtl");
    assert.equal(newmtlLine, "newmtl cloth");
    assert.equal(mapKdLine, "map_Kd texture1.png");
    assert.equal(usemtlLine, "usemtl cloth");
});
