const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const zlib = require("zlib");
const { getLang, t } = require("./i18n");
const { fetchAvatar3D, fetchPlayerAvatar, fetchAvatarMetadataJson, isAllowedMetadataUrl } = require("./avatar-metadata");
const { normalizeObjForExport, renameObjGroups } = require("./obj-utils");
const { getPartInfo } = require("./auto-rig");
const {
    fetchWithTimeout: defaultFetchWithTimeout,
    isTimeoutError
} = require("./fetch-utils");
const { withUserLock, isUserLocked } = require("./user-lock");
const { createAdmissionLimiter } = require("./admission-limiter");
const { parseNonNegativeNumber, parsePositiveNumber } = require("./config");
const { sweepDownloads, entrySize, getAvailableBytes, isOldBackupOfMissingOutput } = require("./downloads-cleanup");
const { version: APP_VERSION } = require("./package.json");

const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2;
const DEFAULT_MAX_DOWNLOAD_QUEUE = 8;
const DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_AVATAR_BYTES = 256 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

class DownloadTooLargeError extends Error {
    constructor(message = "Avatar asset exceeds the configured size limit") {
        super(message);
        this.name = "DownloadTooLargeError";
        this.code = "EASSETTOOLARGE";
        this.status = 413;
    }
}

class CacheQuotaError extends Error {
    constructor(message = "Avatar cache quota exceeded") {
        super(message);
        this.name = "CacheQuotaError";
        this.code = "ECACHEQUOTA";
        this.status = 507;
    }
}

class InsufficientStorageError extends Error {
    constructor(message = "Not enough free disk space for the avatar cache") {
        super(message);
        this.name = "InsufficientStorageError";
        this.code = "ENOSPC";
        this.status = 507;
    }
}

function isAssetTooLarge(error) {
    return Boolean(
        error &&
        (error.code === "EASSETTOOLARGE" || error.code === "ERR_BUFFER_TOO_LARGE")
    );
}

function checkLimitError(error) {
    if (!error) return error;
    if (error.code === "ERR_BUFFER_TOO_LARGE") {
        return new DownloadTooLargeError("Decompressed avatar data exceeds the configured size limit");
    }
    return error;
}


// Per-file asset download chatter is noisy; enable with LOG_ASSETS=1.
const logAssets = process.env.LOG_ASSETS === "1";

function decompress(buffer, maxBytes = DEFAULT_MAX_AVATAR_BYTES) {
    if (buffer.length > maxBytes) {
        throw new DownloadTooLargeError();
    }

    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        try {
            return zlib.gunzipSync(buffer, { maxOutputLength: maxBytes });
        } catch (error) {
            throw checkLimitError(error);
        }
    }

    return buffer;
}

function isValidAssetHash(hash) {
    // Real Roblox CDN hashes are "30DAY-<32 hex>" (or plain hex/base64url);
    // fixtures use short tokens like "hash1"/"objhash". Accept the URL-safe
    // charset only, with a length bound, so path/query separators cannot be
    // injected into the CDN URL.
    return typeof hash === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(hash);
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
        const renames = Object.create(null);

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

function contentLength(response) {
    const value = response.headers && typeof response.headers.get === "function"
        ? response.headers.get("content-length")
        : null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Read a response body without ever buffering more than the configured limits.
 * The optional shared budget carries a per-avatar total across concurrent asset
 * downloads.
 */
async function readResponseLimited(response, { maxBytes, budget } = {}) {
    const limit = Number.isFinite(maxBytes) && maxBytes > 0
        ? maxBytes
        : DEFAULT_MAX_ASSET_BYTES;
    const declared = contentLength(response);

    if (declared !== null && declared > limit) {
        throw new DownloadTooLargeError();
    }

    const remainingBudget = budget && Number.isFinite(budget.max)
        ? budget.max - budget.used
        : Infinity;

    if (declared !== null && declared > remainingBudget) {
        throw new DownloadTooLargeError("Avatar exceeds the configured total size limit");
    }

    if (!response.body || typeof response.body.getReader !== "function") {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > limit || buffer.length > remainingBudget) {
            throw new DownloadTooLargeError();
        }
        if (budget) budget.used += buffer.length;
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = Buffer.from(value);
            total += chunk.length;

            if (total > limit) {
                throw new DownloadTooLargeError();
            }

            if (budget) {
                budget.used += chunk.length;
                if (budget.used > budget.max) {
                    throw new DownloadTooLargeError("Avatar exceeds the configured total size limit");
                }
            }

            chunks.push(chunk);
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw checkLimitError(error);
    }

    return Buffer.concat(chunks, total);
}

async function fetchAssetResponse(url, fetchWithTimeout, headers, signal) {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!isAllowedMetadataUrl(current)) {
            throw new Error("Asset download blocked: destination is not an approved Roblox CDN host");
        }

        const response = await fetchWithTimeout(
            current,
            { headers, signal, redirect: "manual" },
            20000
        );

        if (REDIRECT_STATUS.has(response.status)) {
            const location = response.headers &&
                typeof response.headers.get === "function"
                ? response.headers.get("location")
                : null;

            if (!location) {
                throw new Error("Asset download blocked: redirect without a Location header");
            }

            current = new URL(location, current).toString();
            continue;
        }

        return response;
    }

    throw new Error("Asset download blocked: too many redirects");
}

async function tryDownloadUrl(url, fetchWithTimeout, headers, options = {}) {
    const response = await fetchAssetResponse(url, fetchWithTimeout, headers, options.signal);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return readResponseLimited(response, {
        maxBytes: options.maxBytes,
        budget: options.budget
    });
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
                { ...ASSET_HEADERS, ...options.headers },
                {
                    signal: options.signal,
                    maxBytes: options.maxBytes,
                    budget: options.budget
                }
            );
        } catch (err) {
            lastError.push(`${host}: ${err.message}`);

            // Size limits and cancellation are request-wide failures; never
            // mask them by trying the next CDN host or skipping a texture.
            if (isAssetTooLarge(err) || isTimeoutError(err) || err.name === "AbortError") {
                throw err;
            }

            if (options.allowFailure) {
                if (logAssets) {
                    console.warn(`Asset download failed for ${url}, skipping`);
                }
                continue;
            }
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

let cacheQuotaTail = Promise.resolve();

function withCacheQuotaLock(task) {
    const run = cacheQuotaTail.catch(() => {}).then(task);
    cacheQuotaTail = run.catch(() => {});
    return run;
}

/**
 * Enforce the cache byte quota immediately before committing a staged avatar.
 * The check is serialized so concurrent downloads cannot all observe an
 * under-quota cache and then commit past the limit.
 */
async function enforceCacheQuota(downloadsRoot, outputDir, maxBytes, minAgeMs = 0) {
    if (!(maxBytes > 0)) {
        return;
    }

    return withCacheQuotaLock(async () => {
        const oldSize = entrySize(outputDir);

        // Evict unlocked old entries first; the current user is locked by
        // withUserLock, so its old output and staging directory are preserved.
        // Entries younger than minAgeMs are protected (recently used).
        sweepDownloads(downloadsRoot, Number.POSITIVE_INFINITY, Date.now(), {
            maxBytes,
            minAgeMs,
            shouldSkip: (fullPath, name) => {
                if (isUserLocked(name)) return true;
                const match = /^\.(?:stage|old)-(\d+)-/.exec(name);
                if (match && isUserLocked(match[1])) return true;
                // Never evict a backup whose live output is missing (crash
                // recovery has not run or failed); it is the only copy.
                if (isOldBackupOfMissingOutput(downloadsRoot, name)) return true;
                return false;
            }
        });

        const total = entrySize(downloadsRoot);
        const committed = total - oldSize;

        // If the protected (young) entries alone keep the cache over quota, the
        // new download fails with 507 rather than evicting someone's active
        // avatar.
        if (committed > maxBytes) {
            throw new CacheQuotaError();
        }
    });
}

const OLD_BACKUP_RE = /^\.old-(\d+)-(\d+)/;
const STAGE_DIR_RE = /^\.stage-(\d+)-/;

/**
 * Recover caches left behind by a crash between the two commit renames
 * (`output -> .old-<userId>-<ts>`, then `staging -> output`).
 *
 * - For each `.old-<userId>-*` whose live output directory is missing, restore
 *   the newest backup (by the timestamp in its name) back to `output`.
 * - Remove stale `.stage-*` directories left from before this process started.
 *
 * Idempotent (a second run finds no missing output and no stage dirs) and
 * best-effort: every filesystem step is wrapped so a failure is logged and
 * never crashes startup. Synchronous so it completes before the server listens.
 *
 * @param {string} downloadsRoot
 * @param {{log?: (message: string) => void}} [options]
 * @returns {{restored: string[], removedStages: string[], errors: number}}
 */
function recoverDownloads(downloadsRoot, { log = () => {} } = {}) {
    const result = { restored: [], removedStages: [], errors: 0 };

    let entries;
    try {
        entries = fsSync.readdirSync(downloadsRoot, { withFileTypes: true });
    } catch (err) {
        if (err.code !== "ENOENT") {
            result.errors += 1;
            log(`[recovery] cannot read downloads root: ${err.message}`);
        }
        return result;
    }

    const backups = new Map(); // userId -> [{ name, full, ts }]
    const stages = [];

    for (const entry of entries) {
        const match = OLD_BACKUP_RE.exec(entry.name);

        if (match) {
            const userId = match[1];
            const ts = Number(match[2]) || 0;

            if (!backups.has(userId)) {
                backups.set(userId, []);
            }

            backups.get(userId).push({
                name: entry.name,
                full: path.join(downloadsRoot, entry.name),
                ts
            });
            continue;
        }

        if (STAGE_DIR_RE.test(entry.name)) {
            stages.push({ name: entry.name, full: path.join(downloadsRoot, entry.name) });
        }
    }

    // Restore the newest backup for any user whose output is missing.
    for (const [userId, list] of backups) {
        const output = path.join(downloadsRoot, userId);

        let outputExists = true;
        try {
            fsSync.accessSync(output);
        } catch {
            outputExists = false;
        }

        if (outputExists) {
            continue; // live cache present; leave the backup to the normal sweep
        }

        list.sort((a, b) => b.ts - a.ts); // newest first
        const newest = list[0];

        try {
            fsSync.renameSync(newest.full, output);
            result.restored.push(userId);
            log(`[recovery] restored ${newest.name} -> ${userId}`);
        } catch (err) {
            result.errors += 1;
            log(`[recovery] failed to restore ${newest.name}: ${err.message}`);
        }
    }

    // Remove stale staging directories (all of them predate this process).
    for (const stage of stages) {
        try {
            fsSync.rmSync(stage.full, { recursive: true, force: true });
            result.removedStages.push(stage.name);
        } catch (err) {
            result.errors += 1;
            log(`[recovery] failed to remove ${stage.name}: ${err.message}`);
        }
    }

    return result;
}

// Build an error that carries an explicit HTTP status + i18n message key, so a
// shared download can propagate a specific client response to every waiter.
function downloadResponseError(status, messageKey, code) {
    const error = new Error(messageKey);
    error.status = status;
    error.messageKey = messageKey;
    if (code) error.code = code;
    return error;
}

function isPermissionError(error) {
    return Boolean(error && ["EACCES", "EPERM", "EROFS"].includes(error.code));
}

function isStorageError(error) {
    return Boolean(error && (
        error.code === "ECACHEQUOTA" ||
        error.code === "ENOSPC" ||
        error.code === "EDQUOT"
    ));
}

function sendDownloadSuccess(res, lang, data) {
    if (res.headersSent || res.writableEnded || res.destroyed) {
        return;
    }
    res.json({
        success: true,
        message: t(lang, "download.success"),
        textureCount: data.textureCount,
        files: data.files,
        totalSize: data.totalSize,
        rigType: data.rigType,
        robloxType: data.robloxType,
        compatibility: data.compatibility
    });
}

// Map a shared-download error to the same client response the old inline
// handler produced, for every waiter.
function sendDownloadError(res, lang, error) {
    if (res.headersSent || res.writableEnded || res.destroyed) {
        return;
    }

    // All requesters gone: nothing to send.
    if (error && error.name === "AbortError" && error.code === "ECLIENTABORT") {
        return;
    }

    console.error("Avatar Downloader:", error);

    let status = 500;
    let key = "download.failed";

    if (error && Number.isInteger(error.status) && error.messageKey) {
        status = error.status;
        key = error.messageKey;
    } else if (isAssetTooLarge(error) || error.code === "EOBJTOOLARGE") {
        status = 413;
        key = "download.too_large";
    } else if (isStorageError(error)) {
        status = 507;
        key = "download.no_space";
    } else if (isTimeoutError(error)) {
        status = 504;
        key = "download.timeout";
    } else if (isPermissionError(error)) {
        key = "download.write_failed";
    }

    // The admission-queue-full 503 is transient: advertise a retry.
    if (error && error.code === "EDOWNLOADBUSY") {
        res.set("Retry-After", "5");
    }

    res.status(status).json({
        success: false,
        message: t(lang, key)
    });
}

module.exports = function (app, options = {}) {
    const fetchWithTimeout =
        options.fetchWithTimeout || defaultFetchWithTimeout;

    const getApiKey =
        options.getApiKey ||
        (() => {
            const apiKey = process.env.ROBLOX_API_KEY;
            return apiKey && apiKey !== "your_roblox_api_key_here" ? apiKey : null;
        });

    const maxAssetBytes = options.maxAssetBytes !== undefined
        ? options.maxAssetBytes
        : parsePositiveNumber(process.env.MAX_ASSET_BYTES, DEFAULT_MAX_ASSET_BYTES);
    const maxAvatarBytes = options.maxAvatarBytes !== undefined
        ? options.maxAvatarBytes
        : parsePositiveNumber(process.env.MAX_AVATAR_BYTES, DEFAULT_MAX_AVATAR_BYTES);
    const maxMetadataBytes = options.maxMetadataBytes !== undefined
        ? options.maxMetadataBytes
        : parsePositiveNumber(process.env.MAX_METADATA_BYTES, DEFAULT_MAX_METADATA_BYTES);
    const downloadTimeoutMs = options.downloadTimeoutMs !== undefined
        ? options.downloadTimeoutMs
        : parsePositiveNumber(process.env.DOWNLOAD_TIMEOUT_MS, DEFAULT_DOWNLOAD_TIMEOUT_MS);
    const downloadsMaxBytes = options.downloadsMaxBytes !== undefined
        ? options.downloadsMaxBytes
        : parseNonNegativeNumber(process.env.DOWNLOADS_MAX_BYTES, 5 * 1024 * 1024 * 1024);
    const downloadsMinAgeMs = options.downloadsMinAgeMs !== undefined
        ? options.downloadsMinAgeMs
        : parseNonNegativeNumber(process.env.DOWNLOADS_MIN_AGE_MS, 5 * 60 * 1000);
    const minFreeDiskBytes = options.minFreeDiskBytes !== undefined
        ? options.minFreeDiskBytes
        : parseNonNegativeNumber(process.env.MIN_FREE_DISK_BYTES, 512 * 1024 * 1024);
    const getFreeDiskBytes = options.getFreeDiskBytes || getAvailableBytes;
    const downloadsRoot = options.downloadsRoot || path.join(__dirname, "../downloads");
    const downloadLimiter = options.downloadLimiter || createAdmissionLimiter({
        maxConcurrent: parsePositiveNumber(process.env.MAX_CONCURRENT_DOWNLOADS, DEFAULT_MAX_CONCURRENT_DOWNLOADS),
        maxQueue: parseNonNegativeNumber(process.env.MAX_DOWNLOAD_QUEUE, DEFAULT_MAX_DOWNLOAD_QUEUE),
        code: "EDOWNLOADBUSY",
        message: "Download queue is full"
    });

    // Downloads mutate the cache and can be expensive. HEAD requests must not
    // run the GET handler (Express would otherwise route HEAD to it).
    app.head("/api/roblox/download/:userId", (req, res) => {
        res.set("Allow", "GET").status(405).end();
    });

    // In-flight downloads keyed by userId. A second same-user request joins the
    // existing download instead of starting another. The check-and-set is
    // synchronous and happens BEFORE withUserLock: the per-user lock serializes
    // same-user requests, so a check inside it would never see an in-flight
    // entry (the first request would have to finish and release the lock first).
    const inFlightDownloads = new Map();

    // Perform one download end-to-end and resolve with the response payload.
    // Shared by all coalesced waiters; never touches `res`. The admission slot
    // is held for the whole download and released in finally. The deadline is
    // per-download (not per-requester). Rejections carry either a specific
    // status/messageKey (downloadResponseError) or a code the error mapper knows.
    async function runDownload(userId, apiKey, controller) {
        const signal = controller.signal;
        const outputDir = path.join(downloadsRoot, userId);

        try {
            await fs.mkdir(downloadsRoot, { recursive: true });
            if (minFreeDiskBytes > 0) {
                const freeBytes = await getFreeDiskBytes(downloadsRoot);
                if (Number.isFinite(freeBytes) && freeBytes < minFreeDiskBytes) {
                    console.warn(
                        `[download] free-space guard: ${freeBytes} bytes available, ` +
                        `${minFreeDiskBytes} required`
                    );
                    throw downloadResponseError(507, "download.no_space", "ENOSPC");
                }
            }
        } catch (error) {
            if (error && error.messageKey) throw error;
            console.error("Download storage check failed:", error);
            throw downloadResponseError(500, "download.write_failed");
        }

        let release;
        try {
            release = await downloadLimiter.acquire();
        } catch (error) {
            if (error && error.code === "EDOWNLOADBUSY") {
                throw downloadResponseError(503, "download.busy", "EDOWNLOADBUSY");
            }
            throw error;
        }

        const deadline = setTimeout(() => {
            const error = new Error("Download deadline exceeded");
            error.name = "AbortError";
            error.code = "EDOWNLOADTIMEOUT";
            controller.abort(error);
        }, downloadTimeoutMs);
        if (typeof deadline.unref === "function") deadline.unref();

        try {
            // Serialize same-user cache mutations with conversions/explorer.
            return await withUserLock(userId, async () => {
                const avatar = await fetchAvatar3D(
                    fetchWithTimeout,
                    apiKey,
                    userId,
                    { signal }
                );

                if (!avatar.ok) {
                    console.error(
                        "Avatar metadata lookup failed:",
                        avatar.status,
                        `after ${avatar.attempts} attempt(s)`
                    );
                    throw downloadResponseError(502, "download.upstream_avatar_failed");
                }

                // Roblox avatar-3d API returns imageUrl inside data[0]
                const imageUrl = avatar.imageUrl;

                // Fetch the avatar type hint in parallel with the (slower)
                // metadata JSON so it adds no serial latency. Best-effort.
                const [metadataResult, playerAvatar] = await Promise.all([
                    fetchAvatarMetadataJson(fetchWithTimeout, imageUrl, {
                        signal,
                        maxBytes: maxMetadataBytes
                    }),
                    fetchPlayerAvatar(fetchWithTimeout, apiKey, userId, {
                        attempts: 2,
                        delayMs: 500,
                        signal
                    })
                ]);

                if (!metadataResult.ok) {
                    console.error(
                        "Avatar metadata download failed:",
                        metadataResult.reason,
                        metadataResult.status,
                        `after ${metadataResult.attempts} attempt(s)`
                    );
                    throw downloadResponseError(
                        502,
                        metadataResult.reason === "invalid" ||
                        metadataResult.reason === "blocked"
                            ? "download.metadata_invalid"
                            : "download.metadata_failed"
                    );
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
                                : typeof metadata?.textures
                        })
                    );
                    throw downloadResponseError(502, "download.metadata_incomplete");
                }

                const byteBudget = { used: 0, max: maxAvatarBytes };
                const [objRaw, mtlRaw, ...textureRawBuffers] =
                    await Promise.all([
                        downloadAsset(metadata.obj, fetchWithTimeout, {
                            signal,
                            maxBytes: maxAssetBytes,
                            budget: byteBudget
                        }),
                        downloadAsset(metadata.mtl, fetchWithTimeout, {
                            signal,
                            maxBytes: maxAssetBytes,
                            budget: byteBudget
                        }),
                        ...metadata.textures.map((hash) =>
                            downloadAsset(hash, fetchWithTimeout, {
                                allowFailure: true,
                                signal,
                                maxBytes: maxAssetBytes,
                                budget: byteBudget
                            })
                        )
                    ]);

                let obj = decompress(objRaw, maxAvatarBytes).toString("utf8");
                let mtl = decompress(mtlRaw, maxAvatarBytes).toString("utf8");

                if (
                    Buffer.byteLength(obj) + Buffer.byteLength(mtl) > maxAvatarBytes
                ) {
                    throw new DownloadTooLargeError();
                }

                // Pair textures with their buffers, skipping any that failed.
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

                const plannedBytes =
                    Buffer.byteLength(obj) +
                    Buffer.byteLength(mtl) +
                    textureFiles.reduce((sum, texture) => sum + texture.buffer.length, 0);
                if (plannedBytes > maxAvatarBytes) {
                    throw new DownloadTooLargeError();
                }

                if (/^mtllib\s+/m.test(obj)) {
                    obj = obj.replace(/^mtllib.*$/gm, "mtllib avatar.mtl");
                } else {
                    obj = "mtllib avatar.mtl\n" + obj;
                }

                // Ground the model and mirror group names as objects.
                obj = normalizeObjForExport(obj);

                // Build in a staging directory, then swap into place.
                const stagingDir = await fs.mkdtemp(
                    path.join(downloadsRoot, `.stage-${userId}-`)
                );

                try {
                    await fs.writeFile(path.join(stagingDir, "avatar.obj"), obj);
                    await fs.writeFile(path.join(stagingDir, "avatar.mtl"), mtl);

                    const robloxType = playerAvatar.playerAvatarType || null;

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
                            path.join(stagingDir, "avatar.json"),
                            JSON.stringify(avatarMeta, null, 2)
                        )
                        .catch(() => {});

                    // Rename PlayerN groups, then persist again.
                    const partInfo = applyBodyPartNames(stagingDir, obj, robloxType);
                    obj = partInfo.objText;
                    await fs.writeFile(path.join(stagingDir, "avatar.obj"), obj);

                    await Promise.all(
                        textureFiles.map((texture) =>
                            fs.writeFile(path.join(stagingDir, texture.filename), texture.buffer)
                        )
                    );

                    await enforceCacheQuota(downloadsRoot, outputDir, downloadsMaxBytes, downloadsMinAgeMs);

                    const backupDir = path.join(
                        downloadsRoot,
                        `.old-${userId}-${Date.now()}`
                    );
                    let movedOld = false;

                    try {
                        await fs.rename(outputDir, backupDir);
                        movedOld = true;
                    } catch (error) {
                        if (error.code !== "ENOENT") {
                            throw error;
                        }
                    }

                    try {
                        await fs.rename(stagingDir, outputDir);
                    } catch (error) {
                        // Restore the previous cache rather than leaving the
                        // user with nothing if the final swap fails.
                        if (movedOld) {
                            await fs.rename(backupDir, outputDir).catch(() => {});
                        }
                        throw error;
                    }

                    if (movedOld) {
                        await fs.rm(backupDir, { recursive: true, force: true })
                            .catch(() => {});
                    }

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

                    return {
                        textureCount: textureFiles.length,
                        files,
                        totalSize,
                        rigType: partInfo.rigType,
                        robloxType,
                        compatibility: partInfo.compatibility
                    };
                } catch (error) {
                    await fs.rm(stagingDir, { recursive: true, force: true })
                        .catch(() => {});
                    throw error;
                }
            });
        } finally {
            clearTimeout(deadline);
            release();
        }
    }

    app.get("/api/roblox/download/:userId", async (req, res) => {
        const lang = getLang(req);
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

        // Coalesce concurrent same-user downloads: the first request starts the
        // shared download; later requests join it. The check-and-set is
        // synchronous and runs BEFORE withUserLock (see runDownload).
        let entry = inFlightDownloads.get(userId);
        if (!entry) {
            const controller = new AbortController();
            entry = { controller, waiters: new Set(), promise: null };
            inFlightDownloads.set(userId, entry);
            const promise = runDownload(userId, apiKey, controller);
            entry.promise = promise;
            const cleanup = () => {
                if (inFlightDownloads.get(userId) === entry) {
                    inFlightDownloads.delete(userId);
                }
            };
            promise.then(cleanup, cleanup);
        }

        entry.waiters.add(res);

        // The shared download must NOT be tied to one requester's abort signal:
        // if the first client disconnects, other waiters must still get their
        // result. Only abort the upstream work once ALL waiters are gone.
        const onClose = () => {
            entry.waiters.delete(res);
            if (entry.waiters.size === 0 && !entry.controller.signal.aborted) {
                const error = new Error("All download requesters disconnected");
                error.name = "AbortError";
                error.code = "ECLIENTABORT";
                entry.controller.abort(error);
            }
        };
        res.on("close", onClose);

        try {
            const data = await entry.promise;
            sendDownloadSuccess(res, lang, data);
        } catch (error) {
            sendDownloadError(res, lang, error);
        } finally {
            res.off("close", onClose);
            entry.waiters.delete(res);
        }
    });
};

// Exported for unit tests (pure helper, no Express dependency).
module.exports.planTextures = planTextures;
module.exports.readResponseLimited = readResponseLimited;
module.exports.fetchAssetResponse = fetchAssetResponse;
module.exports.decompress = decompress;
module.exports.isValidAssetHash = isValidAssetHash;
module.exports.recoverDownloads = recoverDownloads;
module.exports.DownloadTooLargeError = DownloadTooLargeError;
