const fs = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { getLang, t } = require("./i18n");

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
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
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
            console.log(`Downloading asset from: ${url}`);
            return await tryDownloadUrl(
                url,
                fetchWithTimeout,
                { ...ASSET_HEADERS, ...options.headers }
            );
        } catch (err) {
            lastError.push(`${host}: ${err.message}`);
            if (options.allowFailure) {
                console.warn(`Asset download failed for ${url}, skipping`);
                continue;
            }
            // For required assets (obj/mtl), try next host before giving up
            continue;
        }
    }

    if (options.allowFailure) {
        console.warn(`All CDN hosts failed for ${hash}: ${lastError.join(", ")}`);
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

            const avatarResponse = await fetchWithTimeout(
                `https://thumbnails.roblox.com/v1/users/avatar-3d?userId=${encodeURIComponent(userId)}`,
                {
                    headers: {
                        "x-api-key": apiKey
                    }
                }
            );

            if (!avatarResponse.ok) {
                return res.status(502).json({
                    success: false,
                    message: t(lang, "download.upstream_avatar_failed")
                });
            }

            const avatarResult = await avatarResponse.json();

            // Roblox avatar-3d API returns imageUrl inside data[0]
            const imageUrl =
                avatarResult?.data?.[0]?.imageUrl ||
                avatarResult?.imageUrl;

            if (!imageUrl || typeof imageUrl !== "string") {
                console.error(
                    "Avatar metadata URL missing. Response keys:",
                    avatarResult && typeof avatarResult === "object"
                        ? Object.keys(avatarResult)
                        : typeof avatarResult,
                    "data sample:",
                    avatarResult?.data?.[0] ? Object.keys(avatarResult.data[0]) : "no data"
                );
                return res.status(502).json({
                    success: false,
                    message: t(lang, "download.metadata_url_missing")
                });
            }

            const metadataResponse = await fetchWithTimeout(imageUrl, {}, 20000);

            if (!metadataResponse.ok) {
                return res.status(502).json({
                    success: false,
                    message: t(lang, "download.metadata_failed")
                });
            }

            const metadataBuffer = Buffer.from(
                await metadataResponse.arrayBuffer()
            );

            let metadata;
            try {
                metadata = JSON.parse(
                    decompress(metadataBuffer).toString("utf8")
                );
            } catch {
                return res.status(502).json({
                    success: false,
                    message: t(lang, "download.metadata_invalid")
                });
            }

            // Debug: log metadata shape for troubleshooting
            console.log(
                "Avatar metadata keys:",
                metadata && typeof metadata === "object"
                    ? Object.keys(metadata)
                    : typeof metadata
            );

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
            const textureFiles = metadata.textures
                .map((hash, index) => {
                    const buffer = textureRawBuffers[index];
                    if (!buffer) {
                        console.warn(`Skipping texture ${hash} (download failed)`);
                        return null;
                    }
                    const filename = `texture${index + 1}.png`;
                    mtl = mtl.replaceAll(hash, filename);
                    return {
                        filename,
                        buffer
                    };
                })
                .filter(Boolean);

            if (/^mtllib\s+/m.test(obj)) {
                obj = obj.replace(/^mtllib.*$/gm, "mtllib avatar.mtl");
            } else {
                obj = "mtllib avatar.mtl\n" + obj;
            }

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

            res.json({
                success: true,
                message: t(lang, "download.success"),
                textureCount: textureFiles.length,
                files
            });

        } catch (error) {
            console.error("Avatar Downloader:", error);
            const isTimeout = error && error.name === "AbortError";
            res.status(isTimeout ? 504 : 500).json({
                success: false,
                message: isTimeout
                    ? t(lang, "download.timeout")
                    : t(lang, "download.failed")
            });
        }
    });
};
