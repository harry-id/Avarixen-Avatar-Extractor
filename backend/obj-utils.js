"use strict";

// OBJ normalization for exported avatars.
//
// Roblox OBJ files keep the character ~100 units above the origin and use only
// `g` groups (no `o` objects). Blender's OBJ importer splits by `o`, so a raw
// file imports as a single merged object. This module grounds the model and
// adds matching `o` names without touching materials or geometry.

const KNOWN_BODY_PARTS = new Set([
    "Head",
    "Torso",
    "Left Arm",
    "Right Arm",
    "Left Leg",
    "Right Leg",
    "UpperTorso",
    "LowerTorso",
    "LeftUpperArm",
    "RightUpperArm",
    "LeftLowerArm",
    "RightLowerArm",
    "LeftHand",
    "RightHand",
    "LeftUpperLeg",
    "RightUpperLeg",
    "LeftLowerLeg",
    "RightLowerLeg",
    "LeftFoot",
    "RightFoot"
].map((name) => name.replace(/\s+/g, "").toLowerCase()));

function normalizeName(name) {
    return String(name).replace(/\s+/g, "").toLowerCase();
}

function emptyBounds() {
    return {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
        found: false
    };
}

function extendBounds(bounds, x, y, z) {
    bounds.found = true;
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (y > bounds.maxY) bounds.maxY = y;
    if (z < bounds.minZ) bounds.minZ = z;
    if (z > bounds.maxZ) bounds.maxZ = z;
}

function isBodyGroup(name) {
    return /^Player\d+$/.test(name) || KNOWN_BODY_PARTS.has(normalizeName(name));
}

function splitVertices(text) {
    const lines = text.split(/\r?\n/);
    const all = emptyBounds();
    const body = emptyBounds();
    let currentGroup = null;

    for (const line of lines) {
        const parts = line.trim().split(/\s+/);

        if (parts[0] === "g") {
            currentGroup = parts.slice(1).join(" ") || null;
            continue;
        }

        if (parts[0] !== "v" || parts.length < 4) {
            continue;
        }

        const x = Number(parts[1]);
        const y = Number(parts[2]);
        const z = Number(parts[3]);

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            continue;
        }

        extendBounds(all, x, y, z);

        if (currentGroup && isBodyGroup(currentGroup)) {
            extendBounds(body, x, y, z);
        }
    }

    return { lines, all, body };
}

function formatCoord(value) {
    const rounded = Math.round(value * 1e6) / 1e6;
    return String(rounded);
}

/**
 * Recenter an OBJ so the body is centred on X/Z and the feet sit at Y = 0.
 * Accessories (Handle groups) are excluded from the offsets so a sword or hat
 * cannot drag the character off the origin.
 *
 * If the file has no `o` declarations, mirror each `g <name>` as `o <name>` so
 * importers that split by object (e.g. Blender) keep every body part.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeObjForExport(text) {
    const { lines, all, body } = splitVertices(text);

    if (!all.found) {
        return text;
    }

    // Prefer the body bounds; fall back to every vertex when groups are absent.
    const bounds = body.found ? body : all;

    const offsetX = (bounds.minX + bounds.maxX) / 2;
    const offsetY = bounds.minY;
    const offsetZ = (bounds.minZ + bounds.maxZ) / 2;

    const hasObjectLines = lines.some(
        (line) => line.trim().split(/\s+/)[0] === "o"
    );

    const out = [];

    for (const line of lines) {
        const parts = line.trim().split(/\s+/);

        if (parts[0] === "v" && parts.length >= 4) {
            const x = Number(parts[1]) - offsetX;
            const y = Number(parts[2]) - offsetY;
            const z = Number(parts[3]) - offsetZ;

            const tail = parts.slice(4).join(" ");
            const vertex = `v ${formatCoord(x)} ${formatCoord(y)} ${formatCoord(z)}`;

            out.push(tail ? `${vertex} ${tail}` : vertex);
            continue;
        }

        if (!hasObjectLines && parts[0] === "g" && parts.length >= 2) {
            out.push(`o ${parts.slice(1).join(" ")}`);
        }

        out.push(line);
    }

    return out.join("\n");
}

/**
 * Rename `g` and `o` declarations using a group-name -> part-name map.
 * Unknown names are left untouched (handles/accessories keep their names).
 *
 * @param {string} text
 * @param {Record<string, string>} renames
 * @returns {string}
 */
function renameObjGroups(text, renames) {
    if (!renames || Object.keys(renames).length === 0) {
        return text;
    }

    return text
        .split(/\r?\n/)
        .map((line) => {
            const parts = line.trim().split(/\s+/);

            if (parts[0] !== "g" && parts[0] !== "o") {
                return line;
            }

            const names = parts.slice(1).map((name) => renames[name] || name);
            return `${parts[0]} ${names.join(" ")}`.trim();
        })
        .join("\n");
}

module.exports = {
    normalizeObjForExport,
    renameObjGroups,
    isBodyGroup,
    KNOWN_BODY_PARTS
};
