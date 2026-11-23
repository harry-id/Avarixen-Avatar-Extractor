// Client-side OBJ export naming helpers for the AAE frontend.

export const DEFAULT_OBJ_ASSET_FILES = ["avatar.obj", "avatar.mtl"];

// Resolve the OBJ/MTL asset file list: prefer the backend-reported list, else
// fall back to the default avatar.obj + avatar.mtl pair.
export function resolveAssetFiles(currentAssetFiles) {
    if (Array.isArray(currentAssetFiles) && currentAssetFiles.length) {
        return currentAssetFiles.map((file) => String(file).split("/").pop());
    }

    return [...DEFAULT_OBJ_ASSET_FILES];
}

// Sanitize a display name / Roblox username for use in export file names.
export function sanitizeExportName(value, fallback = "Avarixen") {
    const safe = String(value || fallback)
        .replace(/[\\/:*?"<>|]/g, "_")
        .trim()
        .replace(/[. ]+$/g, "") || fallback;

    return safe;
}

// OBJ/MTL file name pair for a sanitized export name (lowercase base name).
export function objMtlFileNames(safeName) {
    const baseName = String(safeName).toLowerCase();

    return { obj: `${baseName}.obj`, mtl: `${baseName}.mtl` };
}

// Full in-archive path for an asset file.
export function zipEntryName(safeName, fileName) {
    return `${safeName}/${fileName}`;
}
