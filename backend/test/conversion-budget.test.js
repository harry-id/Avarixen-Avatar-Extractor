"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    effectiveSubdivisionLevel,
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
