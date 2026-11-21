const fs = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { getLang, t } = require("./i18n");
const { fetchAvatar3D, fetchPlayerAvatar, fetchAvatarMetadataJson } = require("./avatar-metadata");
const { normalizeObjForExport, renameObjGroups } = require("./obj-utils");
const { getPartInfo } = require("./auto-rig");
const { version: APP_VERSION } = require("./package.json");

// Per-file asset download chatter is noisy; enable with LOG_ASSETS=1.
const logAssets = process.env.LOG_ASSETS === "1";

function decompress(buffer) {
    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        return zlib.gunzipSync(buffer);
    }

    return buffer;
}

function isValidAssetHash(hash) {
    return typeof hash === "string" && hash.length > 0;
}

function getHost(hash) {
    let value = 31;
    const limit = Math.min(hash.length, 32);

    for (let i = 0; i < limit; i++) {
        value ^= hash.charCodeAt(i);
    }

    return `t${(value % 8 + 8) % 8}.rbxcdn.com`;
}

const ASSET_HEADERS = {
    "User-Agent":
        `Avarixen/${APP_VERSION} (x64) Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36`,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
    "Referer": "https://www.roblox.com/",
    "Origin": "https://www.roblox.com"
};

function getAllHosts(hash) {
    // Roblox CDN has 8 subdomains (t0-t7). If one returns 403, try the others.
    const hosts = [];
    for (let i = 0; i < 8; i++) {
        hosts.push(`t${i}.rbxcdn.com`);
    }
    // Put the computed host first, then the rest
    const computed = getHost(hash);
    return [computed, ...hosts.filter((h) => h !== computed)];
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match a hash only as a whole token so short hashes cannot corrupt MTL
// keywords or material names (e.g. "a" inside "map_Kd").
function hashPattern(hash, flags = "") {
    return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(hash)}(?![A-Za-z0-9])`, flags);
}

/**
 * Assign contiguous textureN.png names to successfully downloaded textures and
 * rewrite the MTL references. Missing textures are reported so their MTL lines
 * can be dropped instead of leaving dangling CDN hashes behind.
 */
function planTextures(hashes, buffers, mtlText) {
    const textures = [];
    const missing = [];
    const renames = new Map();
    let index = 0;

    hashes.forEach((hash, i) => {
        const buffer = buffers[i];

        if (!buffer) {
            missing.push(hash);
            return;
        }

        index += 1;
        const filename = `texture${index}.png`;
        renames.set(hash, filename);
        textures.push({ filename, buffer });
    });

    let mtl = mtlText;

    for (const [hash, filename] of renames) {
        mtl = mtl.replace(hashPattern(hash, "g"), filename);
    }

    if (missing.length) {
        const missingPatterns = missing.map((hash) => hashPattern(hash));
        mtl = mtl
            .split(/\r?\n/)
            .filter((line) => !missingPatterns.some((pattern) => pattern.test(line)))
            .join("\n");
    }

    return { textures, missing, mtl };
}

/**
 * Rename PlayerN groups to body parts (Head, Torso, Left Arm, ...) using the
 * same mapping as the model explorer. Handles/accessories keep their names.
 * `hint` is the Roblox playerAvatarType ("R6"/"R15"), used to disambiguate
 * borderline rigs.
 */
function applyBodyPartNames(assetDir, objText, hint = null) {
    try {
        const info = getPartInfo(assetDir, { hint });
        const renames = {};

        for (const group of info.groups) {
            if (group.name.startsWith("Player") && group.part) {
                // Spaces are group separators in OBJ, so Left Arm -> LeftArm.
                renames[group.name] = group.part.replace(/\s+/g, "");
            }
        }

        return {
            objText: info.rigType ? renameObjGroups(objText, renames) : objText,
            rigType: info.rigType || null,
            compatibility: info.compatibility || null
        };
    } catch (error) {
        console.warn("Body-part renaming skipped:", error.message);
        return { objText, rigType: null, compatibility: null };
    }
}

async function tryDownloadUrl(url, fetchWithTimeout, headers) {
    const response = await fetchWithTimeout(url, { headers }, 20000);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

async function downloadAsset(hash, fetchWithTimeout, options = {}) {
    if (!isValidAssetHash(hash)) {
        throw new Error(`Invalid asset hash: ${hash}`);
    }

    const hosts = getAllHosts(hash);
    const lastError = [];

    for (const host of hosts) {
        const url = `https://${host}/${hash}`;
        try {
            if (logAssets) {
                console.log(`Downloading asset from: ${url}`);
            }
            return await tryDownloadUrl(
                url,
                fetchWithTimeout,
                { ...ASSET_HEADERS, ...options.headers }
            );
        } catch (err) {
            lastError.push(`${host}: ${err.message}`);
            if (options.allowFailure) {
                if (logAssets) {
                    console.warn(`Asset download failed for ${url}, skipping`);
                }
                continue;
            }
            // For required assets (obj/mtl), try next host before giving up
            continue;
        }
    }

    if (options.allowFailure) {
        if (logAssets) {
            console.warn(`All CDN hosts failed for ${hash}: ${lastError.join(", ")}`);
        }
        return null;
    }

    throw new Error(
        `Asset download failed for ${hash} across all CDN hosts: ${lastError.join("; ")}`
    );
}

module.exports = function (app, options = {}) {
    const fetchWithTimeout =
        options.fetchWithTimeout ||
        (async (url, init = {}, timeoutMs = 15000) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await fetch(url, { ...init, signal: controller.signal });
            } finally {
                clearTimeout(timeout);
            }
        });

    const getApiKey =
        options.getApiKey ||
        (() => {
            const apiKey = process.env.ROBLOX_API_KEY;
            return apiKey && apiKey !== "your_roblox_api_key_here" ? apiKey : null;
        });

    app.get("/api/roblox/download/:userId", async (req, res) => {
        const lang = getLang(req);

        try {
            const { userId } = req.params;

            if (!/^\d+$/.test(userId)) {
                return res.status(400).json({
                    success: false,
                    message: t(lang, "download.invalid_user_id")
                });
            }

            const apiKey = getApiKey();

            if (!apiKey) {
                return res.status(500).json({
                    success: false,
                    message: t(lang, "download.not_configured")
                });
            }

            const avatar = await fetchAvatar3D(
                fetchWithTimeout,
                apiKey,
                userId
            );

            if (!avatar.ok) {
                console.error(
                    "Avatar metadata lookup failed:",
                    avatar.status,
                    `after ${avatar.attempts} attempt(s)`
                );
                return res.status(502).json({
                    success: false,
                    message: t(lang, "download.upstream_avatar_failed")
                });
            }

            const avatarResult = avatar.result;
            // Roblox avatar-3d API returns imageUrl inside data[0]
            const imageUrl = avatar.imageUrl;

            // Fetch the avatar type hint in parallel with the (slower) metadata
            // JSON so it adds no serial latency. Best-effort: it never fails the
            // download.
            const [metadataResult, playerAvatar] = await Promise.all([
                fetchAvatarMetadataJson(fetchWithTimeout, imageUrl),
                fetchPlayerAvatar(fetchWithTimeout, apiKey, userId, {
                    attempts: 2,
                    delayMs: 500
                })
            ]);

            if (!metadataResult.ok) {
                console.error(
                    "Avatar metadata download failed:",
                    metadataResult.reason,
                    metadataResult.status,
                    `after ${metadataResult.attempts} attempt(s)`
                );
                return res.status(502).json({
                    success: false,
                    message: t(
                        lang,
                        metadataResult.reason === "invalid"
                            ? "download.metadata_invalid"
                            : "download.metadata_failed"
                    )
                });
            }

            const metadata = metadataResult.metadata;

            if (
                !metadata ||
                typeof metadata !== "object" ||
                !isValidAssetHash(metadata.obj) ||
                !isValidAssetHash(metadata.mtl) ||
                !Array.isArray(metadata.textures) ||
                metadata.textures.length === 0 ||
                metadata.textures.length > 32 ||
                !metadata.textures.every(isValidAssetHash)
            ) {
                console.error(
                    "Metadata validation failed:",
                    JSON.stringify({
                        hasObj: !!metadata?.obj,
                        hasMtl: !!metadata?.mtl,
                        texturesType: Array.isArray(metadata?.textures)
                            ? `array[${metadata.textures.length}]`
                            : typeof metadata?.textures,
                    })
                );
                return res.status(502).json({
                    success: false,
                    message: t(lang, "download.metadata_incomplete")
                });
            }

            const [objRaw, mtlRaw, ...textureRawBuffers] =
                await Promise.all([
                    downloadAsset(metadata.obj, fetchWithTimeout),
                    downloadAsset(metadata.mtl, fetchWithTimeout),
                    ...metadata.textures.map((hash) =>
                        downloadAsset(hash, fetchWithTimeout, { allowFailure: true })
                    )
                ]);

            let obj = decompress(objRaw).toString("utf8");
            let mtl = decompress(mtlRaw).toString("utf8");

            // Pair textures with their buffers, skipping any that failed to download.
            // Names stay contiguous so the frontend ZIP probe sees every texture.
            const texturePlan = planTextures(
                metadata.textures,
                textureRawBuffers,
                mtl
            );

            if (texturePlan.missing.length) {
                console.warn(
                    `[assets] ${texturePlan.missing.length} texture(s) unavailable for ${userId}`
                );
            }

            const textureFiles = texturePlan.textures;
            mtl = texturePlan.mtl;

            if (/^mtllib\s+/m.test(obj)) {
                obj = obj.replace(/^mtllib.*$/gm, "mtllib avatar.mtl");
            } else {
                obj = "mtllib avatar.mtl\n" + obj;
            }

            // Ground the model (Roblox keeps it ~100 units up) and mirror
            // group names as objects so Blender imports every body part.
            obj = normalizeObjForExport(obj);

            const outputDir = path.join(
                __dirname,
                "../downloads",
                userId
            );

            await fs.mkdir(outputDir, { recursive: true });

            // Hapus tekstur lama yang tidak lagi digunakan.
            const existingFiles = await fs.readdir(outputDir).catch(() => []);
            await Promise.all(
                existingFiles
                    .filter((filename) => /^texture\d+\.png$/.test(filename))
                    .map((filename) => fs.unlink(path.join(outputDir, filename)).catch(() => {}))
            );

            await fs.writeFile(path.join(outputDir, "avatar.obj"), obj);
            await fs.writeFile(path.join(outputDir, "avatar.mtl"), mtl);

            const robloxType = playerAvatar.playerAvatarType || null;

            // Cache the hint (and type) so convert/explorer can read it without
            // re-fetching, and keep a small record for debugging.
            const avatarMeta = {
                userId,
                playerAvatarType: robloxType,
                assets: Array.isArray(playerAvatar.assets)
                    ? playerAvatar.assets.map((a) => ({
                        id: a.id,
                        name: a.name,
                        assetType: a.assetType
                    }))
                    : []
            };
            await fs
                .writeFile(
                    path.join(outputDir, "avatar.json"),
                    JSON.stringify(avatarMeta, null, 2)
                )
                .catch(() => {});

            // Rename PlayerN groups to readable body parts, then persist again.
            const partInfo = applyBodyPartNames(outputDir, obj, robloxType);
            obj = partInfo.objText;
            await fs.writeFile(path.join(outputDir, "avatar.obj"), obj);

            await Promise.all(
                textureFiles.map((texture) =>
                    fs.writeFile(path.join(outputDir, texture.filename), texture.buffer)
                )
            );

            const files = [
                `/assets/${userId}/avatar.obj`,
                `/assets/${userId}/avatar.mtl`,
                ...textureFiles.map(
                    (texture) => `/assets/${userId}/${texture.filename}`
                )
            ];

            const totalSize =
                Buffer.byteLength(obj) +
                Buffer.byteLength(mtl) +
                textureFiles.reduce(
                    (sum, texture) => sum + texture.buffer.length,
                    0
                );

            res.json({
                success: true,
                message: t(lang, "download.success"),
                textureCount: textureFiles.length,
                files,
                totalSize,
                rigType: partInfo.rigType,
                robloxType,
                compatibility: partInfo.compatibility
            });

        } catch (error) {
            console.error("Avatar Downloader:", error);
            const isTimeout = error && error.name === "AbortError";
            const isPermissionError =
                error && ["EACCES", "EPERM", "EROFS"].includes(error.code);

            res.status(isTimeout ? 504 : 500).json({
                success: false,
                message: t(
                    lang,
                    isTimeout
                        ? "download.timeout"
                        : isPermissionError
                            ? "download.write_failed"
                            : "download.failed"
                )
            });
        }
    });
};

// Exported for unit tests (pure helper, no Express dependency).
module.exports.planTextures = planTextures;
