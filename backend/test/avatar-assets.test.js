"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
    deriveHasLayeredClothing,
    countAccessoryAssets,
    LAYERED_CLOTHING_IDS,
    THIN_LAYERED_IDS
} = require("../avatar-assets");

const RESEARCH = path.join(
    __dirname,
    "../../docs/research/roblox-asset-types/avatar-asset-types.json"
);

const assets = (...ids) => ids.map((id) => ({ assetType: { id, name: `type-${id}` } }));

test("deriveHasLayeredClothing classifies rigid, layered, mixed and unknown", () => {
    assert.equal(deriveHasLayeredClothing(assets(8, 41, 46)), false);
    assert.equal(deriveHasLayeredClothing(assets(68)), true);
    assert.equal(deriveHasLayeredClothing(assets(8, 68)), true);
    assert.equal(deriveHasLayeredClothing(assets(999)), "unknown");
});

test("deriveHasLayeredClothing handles missing, empty and malformed metadata", () => {
    assert.equal(deriveHasLayeredClothing(undefined), "unknown");
    assert.equal(deriveHasLayeredClothing(null), "unknown");
    assert.equal(deriveHasLayeredClothing([]), "unknown");
    assert.equal(deriveHasLayeredClothing([{ assetType: null }]), "unknown");
    assert.equal(deriveHasLayeredClothing([{ assetType: {} }]), "unknown");
    assert.equal(deriveHasLayeredClothing([{ assetType: 68 }]), true);
});

test("thin layered ids 76/77 stay unknown", () => {
    assert.equal(deriveHasLayeredClothing(assets(76)), "unknown");
    assert.equal(deriveHasLayeredClothing(assets(77)), "unknown");
    assert.equal(deriveHasLayeredClothing(assets(8, 77)), "unknown");
    // A real layered asset still wins over a thin one.
    assert.equal(deriveHasLayeredClothing(assets(77, 67)), true);
});

test("embedded id sets match the research snapshot", () => {
    const research = JSON.parse(fs.readFileSync(RESEARCH, "utf8"));
    const byId = new Map(research.entries.map((entry) => [entry.id, entry]));

    assert.deepEqual(
        [...LAYERED_CLOTHING_IDS].sort((a, b) => a - b),
        research.entries
            .filter((entry) => entry.category === "layered-clothing")
            .map((entry) => entry.id)
            .sort((a, b) => a - b)
    );
    assert.deepEqual(
        [...THIN_LAYERED_IDS].sort((a, b) => a - b),
        research.entries
            .filter((entry) => entry.category === "layered-accessory-thin")
            .map((entry) => entry.id)
            .sort((a, b) => a - b)
    );

    for (const entry of research.entries) {
        const actual = deriveHasLayeredClothing(assets(entry.id));
        const expected =
            entry.category === "layered-clothing"
                ? true
                : entry.category === "layered-accessory-thin"
                    ? "unknown"
                    : false;

        assert.equal(
            actual,
            expected,
            `id ${entry.id} (${entry.name}, ${entry.category})`
        );
    }

    // Ids outside the enum must be unrecognized.
    assert.equal(deriveHasLayeredClothing(assets(1000)), "unknown");
    assert.ok(byId.has(8) && byId.has(68));
});

test("countAccessoryAssets counts recognized, layered and geometric assets", () => {
    const counts = countAccessoryAssets(assets(8, 41, 68, 76, 999));
    assert.equal(counts.recognized, 4); // 8, 41, 68, 76 (999 unrecognized)
    assert.equal(counts.layered, 1); // 68
    assert.equal(counts.geometric, 3); // 8, 41, 68
    assert.deepEqual(countAccessoryAssets(null), {
        recognized: 0,
        layered: 0,
        geometric: 0
    });
});