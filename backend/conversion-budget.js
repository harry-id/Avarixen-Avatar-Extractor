"use strict";

// Output-face budgets for conversion.
//
// The 3.5M-face cap in subdivideParsed/buildFbx is an outer safety bound, but
// it is not memory-safe. Measured under real Docker (--memory=1g --cpus=1,
// Node 26, no NODE_OPTIONS): the container's default V8 heap cap is ~536 MB,
// and a single ~2M-face GLB conversion OOMs even at 1 concurrent (peak RSS
// ~608 MB). The measured 2-concurrent boundary was ~550K output faces (GLB,
// 674 MB VmHWM, pass) vs 600K (OOM); FBX is heavier, 500K passed at 652 MB.
//
// These budgets lower the effective subdivision level before any geometry is
// built so 2 concurrent conversions stay within the 1 GB container. Values are
// chosen from those measurements with margin: 500K (GLB/glTF) and 400K (FBX).
// The 3.5M hard cap remains the outer bound.
//
// Both budgets are configurable via environment variables (MAX_OUTPUT_FACES and
// MAX_OUTPUT_FACES_FBX); see parseBudget below for the validation rules.

const HARD_MAX_OUTPUT_FACES = 3_500_000;
const MAX_SUBDIVISION_LEVEL = 4;

/**
 * Parse an output-face budget from an environment value.
 *
 * Rules (per the task):
 * - Missing/empty, non-numeric, zero or negative values fall back to `fallback`.
 * - A valid value is floored to an integer and clamped to the 3.5M hard max.
 * - The hard max itself is never configurable.
 *
 * @param {string|number|undefined|null} value raw environment value
 * @param {number} fallback default budget
 * @returns {number}
 */
function parseBudget(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return fallback;
    }

    const number = Number(value);

    if (!Number.isFinite(number) || number <= 0) {
        return fallback;
    }

    return Math.min(Math.floor(number), HARD_MAX_OUTPUT_FACES);
}

// Configurable via environment (documented in README and .env.example):
//   MAX_OUTPUT_FACES      GLB/glTF output-face budget (default 500000)
//   MAX_OUTPUT_FACES_FBX  FBX output-face budget (default 400000)
// Both are clamped to HARD_MAX_OUTPUT_FACES (3.5M), which is not configurable.
const MAX_OUTPUT_FACES = parseBudget(process.env.MAX_OUTPUT_FACES, 500_000);
const MAX_OUTPUT_FACES_FBX = parseBudget(
    process.env.MAX_OUTPUT_FACES_FBX,
    400_000
);

/**
 * Reduce the requested subdivision level so the subdivided output stays within
 * `budget` (and never above the 3.5M hard cap). Pure and side-effect free;
 * call before any geometry is built.
 *
 * `faces` is the number of faces that will actually be subdivided (the body
 * faces, excluding the head and Handle* accessories, which keep their original
 * density and therefore do not multiply). Non-subdivided faces are bounded by
 * the OBJ input limits and are not part of this budget.
 *
 * @param {number} faces subdividable source face count
 * @param {number} requested requested level (clamped 0..4)
 * @param {number} budget output-face budget
 * @param {number} [hardCap=3_500_000] outer bound
 * @returns {number} effective level
 */
function effectiveSubdivisionLevel(faces, requested, budget, hardCap = HARD_MAX_OUTPUT_FACES) {
    const source = Number.isFinite(faces) && faces > 0 ? faces : 0;
    if (source === 0) {
        return 0;
    }

    let level = Math.max(
        0,
        Math.min(MAX_SUBDIVISION_LEVEL, Math.floor(Number(requested) || 0))
    );

    const limit = Math.min(
        Number.isFinite(budget) && budget > 0 ? budget : HARD_MAX_OUTPUT_FACES,
        Number.isFinite(hardCap) && hardCap > 0 ? hardCap : HARD_MAX_OUTPUT_FACES
    );

    while (level > 0 && source * Math.pow(4, level) > limit) {
        level -= 1;
    }

    return level;
}

module.exports = {
    HARD_MAX_OUTPUT_FACES,
    MAX_OUTPUT_FACES,
    MAX_OUTPUT_FACES_FBX,
    MAX_SUBDIVISION_LEVEL,
    parseBudget,
    effectiveSubdivisionLevel
};