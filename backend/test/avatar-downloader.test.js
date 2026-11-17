"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { planTextures } = require("../avatar-downloader");

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
