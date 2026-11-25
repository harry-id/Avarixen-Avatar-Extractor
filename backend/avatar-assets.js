"use strict";

// Roblox Enum.AvatarAssetType classification used by the accessory metadata gate.
//
// The id sets below are derived from
// docs/research/roblox-asset-types/avatar-asset-types.json (snapshot 2026-11-24)
// and are validated against that file by test/avatar-assets.test.js. They are
// embedded (rather than read from docs/ at runtime) so the backend keeps working
// in the Docker image, which ships only backend/. If the Roblox enum changes,
// update the research snapshot and this file together.
//
// Important: these are Enum.AvatarAssetType ids (Hat = 8), not Enum.AssetType
// or Enum.AccessoryType ids (Hat = 1). The live avatar endpoint returns the
// former in assets[].assetType.id.

// Verified layered-clothing asset types (category "layered-clothing").
const LAYERED_CLOTHING_IDS = new Set([64, 65, 66, 67, 68, 69, 70, 71, 72]);

// Thin layered accessories. Their runtime representation is unverified, so they
// must not be treated as either layered or rigid (see deriveHasLayeredClothing).
const THIN_LAYERED_IDS = new Set([76, 77]);

// Every id in Enum.AvatarAssetType. Used to decide whether an asset type is
// recognized; anything outside this set makes the classification "unknown".
const KNOWN_AVATAR_ASSET_TYPE_IDS = new Set([
    2, 8, 11, 12, 17, 18, 19, 27, 28, 29, 30, 31,
    41, 42, 43, 44, 45, 46, 47, 48, 50, 51, 52, 53, 54, 55, 61,
    64, 65, 66, 67, 68, 69, 70, 71, 72, 76, 77, 78, 79,
    88, 89, 90, 92, 97
]);

// Accept both shapes seen in the wild: { assetType: { id } } (live avatar API)
// and a bare numeric assetType.
function assetTypeId(asset) {
    const type = asset && asset.assetType;

    if (typeof type === "number") {
        return Number.isInteger(type) ? type : null;
    }

    if (type && Number.isInteger(type.id)) {
        return type.id;
    }

    return null;
}

/**
 * Tri-state layered-clothing classification for an avatar's assets[].
 *
 * - true: at least one verified layered-clothing asset (AvatarAssetType 64-72).
 * - false: non-empty list, every asset type recognized, none layered/thin.
 * - "unknown": missing/malformed/empty list, an unrecognized type, or a thin
 *   layered type (76/77) whose handling is unverified.
 *
 * Pure and side-effect free.
 *
 * @param {Array<{assetType?: {id?: number}|number}>} assets
 * @returns {boolean|"unknown"}
 */
function deriveHasLayeredClothing(assets) {
    if (!Array.isArray(assets) || assets.length === 0) {
        return "unknown";
    }

    let sawRecognizedNonThin = false;
    let sawThin = false;

    for (const asset of assets) {
        const id = assetTypeId(asset);

        if (id === null || !KNOWN_AVATAR_ASSET_TYPE_IDS.has(id)) {
            return "unknown";
        }

        if (LAYERED_CLOTHING_IDS.has(id)) {
            return true;
        }

        if (THIN_LAYERED_IDS.has(id)) {
            sawThin = true;
        } else {
            sawRecognizedNonThin = true;
        }
    }

    // Thin layered accessories are recognized but not classified yet.
    if (sawThin) {
        return "unknown";
    }

    return sawRecognizedNonThin ? false : "unknown";
}

/**
 * Count recognized asset categories for diagnostics. Does not log or throw.
 *
 * @param {Array} assets
 * @returns {{recognized: number, layered: number, geometric: number}}
 */
function countAccessoryAssets(assets) {
    let recognized = 0;
    let layered = 0;
    let geometric = 0;

    if (!Array.isArray(assets)) {
        return { recognized, layered, geometric };
    }

    for (const asset of assets) {
        const id = assetTypeId(asset);

        if (id === null || !KNOWN_AVATAR_ASSET_TYPE_IDS.has(id)) {
            continue;
        }

        recognized += 1;

        if (LAYERED_CLOTHING_IDS.has(id)) {
            layered += 1;
            geometric += 1;
        } else if (id === 8 || (id >= 41 && id <= 47)) {
            // Rigid accessories (Hat + Hair/Face/Neck/Shoulder/Front/Back/Waist).
            geometric += 1;
        }
    }

    return { recognized, layered, geometric };
}

module.exports = {
    LAYERED_CLOTHING_IDS,
    THIN_LAYERED_IDS,
    KNOWN_AVATAR_ASSET_TYPE_IDS,
    assetTypeId,
    deriveHasLayeredClothing,
    countAccessoryAssets
};