"use strict";

// OBJ normalization for exported avatars.
//
// Roblox OBJ files keep the character ~100 units above the origin and use only
// `g` groups (no `o` objects). Blender's OBJ importer splits by `o`, so a raw
// file imports as a single merged object. This module grounds the model and
// adds matching `o` names without touching materials or geometry.

function splitVertices(text) {
    const lines = text.split(/\r?\n/);
    const bounds = {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity
    };
    let found = false;

    for (const line of lines) {
        const parts = line.trim().split(/\s+/);

        if (parts[0] !== "v" || parts.length < 4) {
            continue;
        }

        const x = Number(parts[1]);
        const y = Number(parts[2]);
        const z = Number(parts[3]);

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            continue;
        }

        found = true;
        if (x < bounds.minX) bounds.minX = x;
        if (x > bounds.maxX) bounds.maxX = x;
        if (y < bounds.minY) bounds.minY = y;
        if (y > bounds.maxY) bounds.maxY = y;
        if (z < bounds.minZ) bounds.minZ = z;
        if (z > bounds.maxZ) bounds.maxZ = z;
    }

    return { lines, bounds, found };
}

function formatCoord(value) {
    const rounded = Math.round(value * 1e6) / 1e6;
    return String(rounded);
}

/**
 * Recenter an OBJ so X/Z are centred on the origin and the feet sit at Y = 0.
 * If the file has no `o` declarations, mirror each `g <name>` as `o <name>` so
 * importers that split by object (e.g. Blender) keep every body part.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeObjForExport(text) {
    const { lines, bounds, found } = splitVertices(text);

    if (!found) {
        return text;
    }

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

module.exports = { normalizeObjForExport };
