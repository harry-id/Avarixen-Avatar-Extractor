"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    effectiveSubdivisionLevel,
    parseBudget,
    MAX_OUTPUT_FACES,
    MAX_OUTPUT_FACES_FBX,
    HARD_MAX_OUTPUT_FACES
} = require("../conversion-budget");

test("GLB/glTF budget reduces level at exact 500K-face boundaries", () => {
    // level 4: floor(500,000 / 256) = 1,953
    assert.equal(effectiveSubdivisionLevel(1_953, 4, MAX_OUTPUT_FACES), 4);
    assert.equal(effectiveSubdivisionLevel(1_954, 4, MAX_OUTPUT_FACES), 3);

    // level 3: floor(500,000 / 64) = 7,812
    assert.equal(effectiveSubdivisionLevel(7_812, 3, MAX_OUTPUT_FACES), 3);
    assert.equal(effectiveSubdivisionLevel(7_813, 3, MAX_OUTPUT_FACES), 2);

    // level 2: floor(500,000 / 16) = 31,250
    assert.equal(effectiveSubdivisionLevel(31_250, 2, MAX_OUTPUT_FACES), 2);
    assert.equal(effectiveSubdivisionLevel(31_251, 2, MAX_OUTPUT_FACES), 1);

    // level 1: floor(500,000 / 4) = 125,000
    assert.equal(effectiveSubdivisionLevel(125_000, 1, MAX_OUTPUT_FACES), 1);
    assert.equal(effectiveSubdivisionLevel(125_001, 1, MAX_OUTPUT_FACES), 0);
});

test("FBX budget is lower and reduces at its own 400K boundaries", () => {
    // level 4: floor(400,000 / 256) = 1,562
    assert.equal(effectiveSubdivisionLevel(1_562, 4, MAX_OUTPUT_FACES_FBX), 4);
    assert.equal(effectiveSubdivisionLevel(1_563, 4, MAX_OUTPUT_FACES_FBX), 3);

    // level 3: floor(400,000 / 64) = 6,250
    assert.equal(effectiveSubdivisionLevel(6_250, 3, MAX_OUTPUT_FACES_FBX), 3);
    assert.equal(effectiveSubdivisionLevel(6_251, 3, MAX_OUTPUT_FACES_FBX), 2);
});

test("the 3.5M hard cap remains an outer bound when the budget is larger", () => {
    const huge = 10_000_000;
    // 13,580 * 256 = 3,476,480 <= 3.5M -> level 4
    assert.equal(effectiveSubdivisionLevel(13_580, 4, huge), 4);
    // 13,672 * 256 = 3,500,032 > 3.5M -> level 3
    assert.equal(effectiveSubdivisionLevel(13_672, 4, huge), 3);
    assert.equal(HARD_MAX_OUTPUT_FACES, 3_500_000);
});

test("requested level is clamped and degenerate inputs return 0", () => {
    assert.equal(effectiveSubdivisionLevel(1_000, 9, MAX_OUTPUT_FACES), 4);
    assert.equal(effectiveSubdivisionLevel(1_000, -1, MAX_OUTPUT_FACES), 0);
    assert.equal(effectiveSubdivisionLevel(1_000, 0, MAX_OUTPUT_FACES), 0);
    assert.equal(effectiveSubdivisionLevel(1_000, Number.NaN, MAX_OUTPUT_FACES), 0);
    assert.equal(effectiveSubdivisionLevel(0, 4, MAX_OUTPUT_FACES), 0);
    assert.equal(effectiveSubdivisionLevel(undefined, 4, MAX_OUTPUT_FACES), 0);
});

test("a max-face input is not subdivided", () => {
    // 1,000,000 * 4^4 is far above both budgets; level 0.
    assert.equal(effectiveSubdivisionLevel(1_000_000, 4, MAX_OUTPUT_FACES), 0);
    assert.equal(effectiveSubdivisionLevel(1_000_000, 4, MAX_OUTPUT_FACES_FBX), 0);
});

// ---- Environment parsing (MAX_OUTPUT_FACES / MAX_OUTPUT_FACES_FBX) ----

test("parseBudget returns the fallback for missing or empty values", () => {
    assert.equal(parseBudget(undefined, 500_000), 500_000);
    assert.equal(parseBudget(null, 500_000), 500_000);
    assert.equal(parseBudget("", 500_000), 500_000);
    assert.equal(parseBudget("   ", 500_000), 500_000);
});

test("parseBudget accepts a valid numeric override", () => {
    assert.equal(parseBudget("750000", 500_000), 750_000);
    assert.equal(parseBudget("1000", 500_000), 1_000);
    assert.equal(parseBudget(250_000, 500_000), 250_000);
    // Floors fractional input to an integer.
    assert.equal(parseBudget("1000.9", 500_000), 1_000);
});

test("parseBudget ignores non-numeric, zero and negative values", () => {
    assert.equal(parseBudget("abc", 500_000), 500_000);
    assert.equal(parseBudget("12x", 500_000), 500_000);
    assert.equal(parseBudget("0", 500_000), 500_000);
    assert.equal(parseBudget("-1", 500_000), 500_000);
    assert.equal(parseBudget("-250000", 500_000), 500_000);
    assert.equal(parseBudget(Number.NaN, 500_000), 500_000);
});

test("parseBudget clamps to the 3.5M hard max", () => {
    assert.equal(parseBudget("3500000", 500_000), 3_500_000);
    assert.equal(parseBudget("9999999", 500_000), 3_500_000);
    assert.equal(parseBudget("10000000", 500_000), HARD_MAX_OUTPUT_FACES);
});

test("module budgets read the environment at load time", () => {
    const path = require.resolve("../conversion-budget");
    const saved = {
        MAX_OUTPUT_FACES: process.env.MAX_OUTPUT_FACES,
        MAX_OUTPUT_FACES_FBX: process.env.MAX_OUTPUT_FACES_FBX
    };

    try {
        process.env.MAX_OUTPUT_FACES = "750000";
        process.env.MAX_OUTPUT_FACES_FBX = "9999999";
        delete require.cache[path];
        const fresh = require(path);

        assert.equal(fresh.MAX_OUTPUT_FACES, 750_000);
        // FBX override is clamped to the hard max.
        assert.equal(fresh.MAX_OUTPUT_FACES_FBX, 3_500_000);

        // Invalid values fall back to the documented defaults.
        process.env.MAX_OUTPUT_FACES = "nope";
        process.env.MAX_OUTPUT_FACES_FBX = "-5";
        delete require.cache[path];
        const fallback = require(path);

        assert.equal(fallback.MAX_OUTPUT_FACES, 500_000);
        assert.equal(fallback.MAX_OUTPUT_FACES_FBX, 400_000);
    } finally {
        if (saved.MAX_OUTPUT_FACES === undefined) delete process.env.MAX_OUTPUT_FACES;
        else process.env.MAX_OUTPUT_FACES = saved.MAX_OUTPUT_FACES;
        if (saved.MAX_OUTPUT_FACES_FBX === undefined) delete process.env.MAX_OUTPUT_FACES_FBX;
        else process.env.MAX_OUTPUT_FACES_FBX = saved.MAX_OUTPUT_FACES_FBX;
        // Restore the original module instance for other tests in this file.
        delete require.cache[path];
        require(path);
    }
});