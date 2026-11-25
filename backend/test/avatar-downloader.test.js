"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { planTextures, isValidAssetHash } = require("../avatar-downloader");

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
