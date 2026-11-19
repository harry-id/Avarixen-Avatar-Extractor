"use strict";

const fs = require("fs/promises");
const path = require("path");

const { getLang, t } = require("./i18n");
const { fetchAvatarMetadataJson } = require("./avatar-metadata");
const {
    downloadAsset,
    planTextures,
    decompress
} = require("./avatar-downloader");
const { normalizeObjForExport } = require("./obj-utils");

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 1500;
const RETRYABLE_STATUS = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

// Catalog search only accepts a fixed set of page sizes.
const SEARCH_LIMITS = [10, 28, 30, 60, 120];

// Asset types that can produce a 3D thumbnail. Used only for UI hints; the
// server still attempts the lookup for every item.
const CATALOG_3D_ASSET_TYPES = new Set([
    8, 41, 42, 43, 44, 45, 46, 47, 66, 67, 68, 78, 79
]);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function catalog3dUrl(assetId) {
    return `https://thumbnails.roblox.com/v1/assets-thumbnail-3d?assetId=${encodeURIComponent(assetId)}`;
}

function isValidAssetHash(hash) {
    return typeof hash === "string" && hash.length > 0;
}

function isValidAssetId(value) {
    return /^\d+$/.test(String(value || ""));
}

/**
 * Fetch the Roblox 3D-thumbnail metadata for a catalog asset.
 *
 * Mirrors fetchAvatar3D: retries while the thumbnail is pending, resolves the
 * metadata JSON (obj/mtl/textures) and returns a normalized result.
 */
async function fetchCatalog3D(fetchWithTimeout, apiKey, assetId, options = {}) {
    const attempts = options.attempts || DEFAULT_ATTEMPTS;
    const delayMs = options.delayMs !== undefined ? options.delayMs : DEFAULT_DELAY_MS;

    let last = {
        ok: false,
        state: null,
        status: null,
        imageUrl: null,
        attempts: 0
    };

    for (let attempt = 1; attempt <= attempts; attempt++) {
        let response;

        try {
            response = await fetchWithTimeout(
                catalog3dUrl(assetId),
                { headers: { "x-api-key": apiKey } }
            );
        } catch (error) {
            last = {
                ok: false,
                state: null,
                status: null,
                imageUrl: null,
                attempts: attempt,
                error
            };

            if (attempt >= attempts) {
                throw error;
            }

            console.warn(
                `Catalog 3D request failed (attempt ${attempt}/${attempts}): ${error.message}. Retrying...`
            );
            await sleep(delayMs);
            continue;
        }

        let result = null;
        try {
            result = await response.json();
        } catch {
            result = null;
        }

        const state = result?.state || null;
        const imageUrl = result?.imageUrl || null;

        last = {
            ok: false,
            state,
            status: response.status,
            imageUrl,
            attempts: attempt
        };

        if (response.ok && state === "Completed" && imageUrl) {
            const metadataResult = await fetchAvatarMetadataJson(
                fetchWithTimeout,
                imageUrl
            );

            if (metadataResult.ok) {
                return {
                    ok: true,
                    state,
                    imageUrl,
                    metadata: metadataResult.metadata,
                    attempts: attempt
                };
            }

            last = {
                ...last,
                state: "MetadataError",
                reason: metadataResult.reason
            };
        } else if (
            response.ok &&
            (state === "Error" || state === "Blocked" || state === "Moderated")
        ) {
            // No 3D thumbnail exists for this asset.
            return last;
        } else if (!response.ok && !RETRYABLE_STATUS.has(response.status)) {
            // Auth/permission/not-found problems will not fix themselves.
            return last;
        }

        if (attempt < attempts) {
            console.warn(
                `Catalog 3D not ready (attempt ${attempt}/${attempts}, state ${state}, status ${response.status}). Retrying...`
            );
            await sleep(delayMs);
        }
    }

    return last;
}

/**
 * Search the Roblox catalog. Returns the raw { data, nextPageCursor } payload.
 */
async function searchCatalog(fetchWithTimeout, options = {}) {
    const q = String(options.q || "").trim().slice(0, 100);
    const category = String(options.category || "").trim();
    const cursor = String(options.cursor || "").trim();
    const requestedLimit = Number.parseInt(options.limit, 10) || 28;
    const limit = SEARCH_LIMITS.includes(requestedLimit) ? requestedLimit : 28;

    const url = new URL("https://catalog.roblox.com/v2/search/items/details");
    url.searchParams.set("limit", String(limit));
    if (q) url.searchParams.set("keyword", q);
    if (category) url.searchParams.set("categoryFilter", category);
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetchWithTimeout(
        url.toString(),
        { headers: { Accept: "application/json" } },
        15000
    );

    let json = null;
    try {
        json = await response.json();
    } catch {
        json = null;
    }

    if (!response.ok) {
        const message =
            json?.errors?.[0]?.message ||
            `Catalog search failed with HTTP ${response.status}`;
        throw new Error(message);
    }

    return json || { data: [], nextPageCursor: null };
}

/**
 * Resolve thumbnail image URLs for a list of asset IDs.
 */
async function getCatalogThumbnails(fetchWithTimeout, assetIds) {
    const ids = (assetIds || [])
        .map((id) => String(id).trim())
        .filter((id) => isValidAssetId(id))
        .slice(0, 100);

    if (!ids.length) {
        return [];
    }

    const url =
        `https://thumbnails.roblox.com/v1/assets?assetIds=${ids.join(",")}` +
        `&size=150x150&format=Png&isCircular=false`;

    const response = await fetchWithTimeout(
        url,
        { headers: { Accept: "application/json" } },
        15000
    );

    if (!response.ok) {
        throw new Error(`Thumbnail lookup failed with HTTP ${response.status}`);
    }

    const json = await response.json();
    return Array.isArray(json?.data) ? json.data : [];
}

/**
 * Fetch Creator Store / catalog asset details.
 */
async function getCatalogAsset(fetchWithTimeout, assetId) {
    const url = `https://apis.roblox.com/toolbox-service/v2/assets/${encodeURIComponent(assetId)}`;

    const response = await fetchWithTimeout(
        url,
        { headers: { Accept: "application/json" } },
        15000
    );

    let json = null;
    try {
        json = await response.json();
    } catch {
        json = null;
    }

    if (!response.ok) {
        const message =
            json?.errors?.[0]?.message ||
            `Asset lookup failed with HTTP ${response.status}`;
        throw new Error(message);
    }

    return json || null;
}

function normalizeCatalogItem(item, thumbnailMap) {
    const assetType = Number.isFinite(item?.assetType)
        ? item.assetType
        : null;

    return {
        id: item?.id ?? null,
        name: item?.name || "",
        itemType: item?.itemType || "Asset",
        assetType,
        supports3d: assetType !== null && CATALOG_3D_ASSET_TYPES.has(assetType),
        price: item?.price ?? null,
        priceStatus: item?.priceStatus || null,
        creatorName: item?.creatorName || null,
        creatorType: item?.creatorType || null,
        thumbnail: thumbnailMap.get(item?.id) || null
    };
}

/**
 * Download the catalog 3D thumbnail files into downloads/<assetKey>/ using the
 * same OBJ/MTL/texture layout as avatar downloads.
 */
async function persistCatalogFiles({
    metadata,
    fetchWithTimeout,
    outputDir
}) {
    await fs.mkdir(outputDir, { recursive: true });

    const [objRaw, mtlRaw, ...textureRawBuffers] = await Promise.all([
        downloadAsset(metadata.obj, fetchWithTimeout),
        downloadAsset(metadata.mtl, fetchWithTimeout),
        ...metadata.textures.map((hash) =>
            downloadAsset(hash, fetchWithTimeout, { allowFailure: true })
        )
    ]);

    let obj = decompress(objRaw).toString("utf8");
    let mtl = decompress(mtlRaw).toString("utf8");

    const texturePlan = planTextures(
        metadata.textures,
        textureRawBuffers,
        mtl
    );

    for (const hash of texturePlan.missing) {
        console.warn(`Skipping texture ${hash} (download failed)`);
    }

    mtl = texturePlan.mtl;

    if (/^mtllib\s+/m.test(obj)) {
        obj = obj.replace(/^mtllib.*$/gm, "mtllib avatar.mtl");
    } else {
        obj = "mtllib avatar.mtl\n" + obj;
    }

    obj = normalizeObjForExport(obj);

    await fs.writeFile(path.join(outputDir, "avatar.obj"), obj);
    await fs.writeFile(path.join(outputDir, "avatar.mtl"), mtl);

    await Promise.all(
        texturePlan.textures.map((texture) =>
            fs.writeFile(
                path.join(outputDir, texture.filename),
                texture.buffer
            )
        )
    );

    return {
        textureFiles: texturePlan.textures,
        obj,
        mtl
    };
}

function registerCatalogRoutes(app, options = {}) {
    const fetchWithTimeout = options.fetchWithTimeout;
    const getApiKey = options.getApiKey || (() => process.env.ROBLOX_API_KEY || null);

    app.get("/api/roblox/catalog/search", async (req, res) => {
        const lang = getLang(req);

        try {
            const raw = await searchCatalog(fetchWithTimeout, {
                q: req.query.q,
                category: req.query.category,
                cursor: req.query.cursor,
                limit: req.query.limit
            });

            const items = Array.isArray(raw.data) ? raw.data : [];
            const assetIds = items
                .filter((item) => item?.itemType === "Asset")
                .map((item) => item.id);

            let thumbnails = [];
            try {
                thumbnails = await getCatalogThumbnails(
                    fetchWithTimeout,
                    assetIds
                );
            } catch (error) {
                console.warn("Catalog thumbnail lookup failed:", error.message);
            }

            const thumbnailMap = new Map(
                thumbnails
                    .filter((entry) => entry?.imageUrl)
                    .map((entry) => [entry.targetId, entry.imageUrl])
            );

            res.json({
                success: true,
                items: items.map((item) =>
                    normalizeCatalogItem(item, thumbnailMap)
                ),
                nextPageCursor: raw.nextPageCursor || null
            });
        } catch (error) {
            console.error("Catalog search failed:", error);
            res.status(502).json({
                success: false,
                message: t(lang, "catalog.search_failed")
            });
        }
    });

    app.get("/api/roblox/catalog/thumbnails", async (req, res) => {
        const lang = getLang(req);

        try {
            const ids = String(req.query.assetIds || "")
                .split(",")
                .map((id) => id.trim())
                .filter((id) => isValidAssetId(id))
                .slice(0, 100);

            const data = await getCatalogThumbnails(fetchWithTimeout, ids);

            res.json({ success: true, data });
        } catch (error) {
            console.error("Catalog thumbnails failed:", error);
            res.status(502).json({
                success: false,
                message: t(lang, "catalog.search_failed")
            });
        }
    });

    app.get("/api/roblox/catalog/asset/:assetId", async (req, res) => {
        const lang = getLang(req);
        const { assetId } = req.params;

        if (!isValidAssetId(assetId)) {
            return res.status(400).json({
                success: false,
                message: t(lang, "catalog.invalid_asset_id")
            });
        }

        try {
            const asset = await getCatalogAsset(fetchWithTimeout, assetId);
            res.json({ success: true, asset });
        } catch (error) {
            console.error("Catalog asset lookup failed:", error);
            res.status(502).json({
                success: false,
                message: t(lang, "catalog.search_failed")
            });
        }
    });

    app.get("/api/roblox/catalog/download/:assetId", async (req, res) => {
        const lang = getLang(req);
        const { assetId } = req.params;

        if (!isValidAssetId(assetId)) {
            return res.status(400).json({
                success: false,
                message: t(lang, "catalog.invalid_asset_id")
            });
        }

        const apiKey = getApiKey();
        if (!apiKey) {
            return res.status(500).json({
                success: false,
                message: t(lang, "download.not_configured")
            });
        }

        try {
            const result = await fetchCatalog3D(
                fetchWithTimeout,
                apiKey,
                assetId
            );

            if (!result.ok) {
                if (result.state === "Error" ||
                    result.state === "Blocked" ||
                    result.state === "Moderated") {
                    return res.status(422).json({
                        success: false,
                        message: t(lang, "catalog.no_3d")
                    });
                }

                console.error(
                    "Catalog 3D lookup failed:",
                    result.state,
                    result.status,
                    `after ${result.attempts} attempt(s)`
                );

                return res.status(502).json({
                    success: false,
                    message: t(lang, "catalog.not_ready")
                });
            }

            const metadata = result.metadata;

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
                    "Catalog metadata validation failed:",
                    JSON.stringify({
                        hasObj: !!metadata?.obj,
                        hasMtl: !!metadata?.mtl,
                        texturesType: Array.isArray(metadata?.textures)
                            ? `array[${metadata.textures.length}]`
                            : typeof metadata?.textures
                    })
                );

                return res.status(502).json({
                    success: false,
                    message: t(lang, "catalog.metadata_invalid")
                });
            }

            const assetKey = `asset-${assetId}`;
            const outputDir = path.join(__dirname, "../downloads", assetKey);

            const persisted = await persistCatalogFiles({
                metadata,
                fetchWithTimeout,
                outputDir
            });

            const files = [
                `/assets/${assetKey}/avatar.obj`,
                `/assets/${assetKey}/avatar.mtl`,
                ...persisted.textureFiles.map(
                    (texture) => `/assets/${assetKey}/${texture.filename}`
                )
            ];

            const totalSize =
                Buffer.byteLength(persisted.obj) +
                Buffer.byteLength(persisted.mtl) +
                persisted.textureFiles.reduce(
                    (sum, texture) => sum + texture.buffer.length,
                    0
                );

            res.json({
                success: true,
                message: t(lang, "catalog.download_success"),
                assetId,
                assetKey,
                textureCount: persisted.textureFiles.length,
                files,
                totalSize
            });
        } catch (error) {
            console.error("Catalog download failed:", error);
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
                            : "catalog.metadata_failed"
                )
            });
        }
    });
}

module.exports = {
    registerCatalogRoutes,
    fetchCatalog3D,
    searchCatalog,
    getCatalogThumbnails,
    getCatalogAsset,
    persistCatalogFiles
};