"use strict";

const zlib = require("zlib");

// Roblox may answer with "empty" avatar metadata while the avatar is still
// being generated, so both the thumbnail lookup and the metadata JSON fetch
// are retried a few times before giving up.
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_DELAY_MS = 1500;

const RETRYABLE_STATUS = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function avatar3dUrl(userId) {
    return `https://thumbnails.roblox.com/v1/users/avatar-3d?userId=${encodeURIComponent(userId)}`;
}

function avatarInfoUrl(userId) {
    return `https://avatar.roblox.com/v1/users/${encodeURIComponent(userId)}/avatar`;
}

/**
 * Fetch the player's avatar configuration, which includes `playerAvatarType`
 * ("R6" or "R15"). Used as a disambiguation hint for rig detection; the
 * authoritative compatibility signal is still the exported geometry.
 *
 * Best-effort: never throws. Returns { ok, playerAvatarType, assets } so the
 * caller can cache the hint and keep going even if the endpoint is unavailable.
 */
async function fetchPlayerAvatar(fetchWithTimeout, apiKey, userId, options = {}) {
    const attempts = options.attempts || 1;
    const delayMs = options.delayMs !== undefined ? options.delayMs : 0;

    let last = { ok: false, playerAvatarType: null, assets: [] };

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await fetchWithTimeout(
                avatarInfoUrl(userId),
                { headers: { "x-api-key": apiKey } },
                15000
            );

            if (!response.ok) {
                last = { ok: false, playerAvatarType: null, assets: [] };
                return last;
            }

            const data = await response.json();
            const type =
                data && (data.playerAvatarType === "R6" || data.playerAvatarType === "R15")
                    ? data.playerAvatarType
                    : null;

            last = {
                ok: true,
                playerAvatarType: type,
                assets: Array.isArray(data?.assets) ? data.assets : []
            };
            return last;
        } catch (error) {
            last = { ok: false, playerAvatarType: null, assets: [] };
            if (attempt < attempts) {
                console.warn(
                    `Avatar info request failed (attempt ${attempt}/${attempts}): ${error.message}. Retrying...`
                );
                if (delayMs) {
                    await sleep(delayMs);
                }
            }
        }
    }

    return last;
}

function resolveImageUrl(result) {
    return result?.data?.[0]?.imageUrl || result?.imageUrl || null;
}

/**
 * Only follow metadata URLs that point at Roblox's own infrastructure.
 * The URL comes from an upstream JSON payload, so without this check a
 * compromised/misbehaving response could make the server request arbitrary
 * internal addresses (SSRF).
 */
function isAllowedMetadataUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) {
        return false;
    }

    let url;

    try {
        url = new URL(rawUrl);
    } catch {
        return false;
    }

    if (url.protocol !== "https:") {
        return false;
    }

    const hostname = url.hostname.toLowerCase();

    return (
        hostname === "roblox.com" ||
        hostname.endsWith(".roblox.com") ||
        hostname === "rbxcdn.com" ||
        hostname.endsWith(".rbxcdn.com")
    );
}

async function fetchAvatar3D(fetchWithTimeout, apiKey, userId, options = {}) {
    const attempts = options.attempts || DEFAULT_ATTEMPTS;
    const delayMs = options.delayMs !== undefined ? options.delayMs : DEFAULT_DELAY_MS;

    let last = { ok: false, status: null, result: null, imageUrl: null, attempts: 0 };

    for (let attempt = 1; attempt <= attempts; attempt++) {
        let response;

        try {
            response = await fetchWithTimeout(
                avatar3dUrl(userId),
                { headers: { "x-api-key": apiKey } }
            );
        } catch (error) {
            // Network / timeout errors are retried like retryable HTTP statuses.
            last = {
                ok: false,
                status: null,
                result: null,
                imageUrl: null,
                attempts: attempt,
                error
            };

            if (attempt >= attempts) {
                // Preserve the caller's timeout (504) / failure (500) mapping.
                throw error;
            }

            console.warn(
                `Avatar metadata request failed (attempt ${attempt}/${attempts}): ${error.message}. Retrying...`
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

        const imageUrl = resolveImageUrl(result);

        last = {
            ok: false,
            status: response.status,
            result,
            imageUrl,
            attempts: attempt
        };

        if (response.ok && imageUrl) {
            return { ...last, ok: true };
        }

        // Auth/permission problems will not fix themselves.
        if (!response.ok && !RETRYABLE_STATUS.has(response.status)) {
            return last;
        }

        if (attempt < attempts) {
            console.warn(
                `Avatar metadata not ready (attempt ${attempt}/${attempts}, status ${response.status}). Retrying...`
            );
            await sleep(delayMs);
        }
    }

    return last;
}

function decodeMetadata(buffer) {
    const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    const text = isGzip
        ? zlib.gunzipSync(buffer).toString("utf8")
        : buffer.toString("utf8");

    return JSON.parse(text);
}

async function fetchAvatarMetadataJson(fetchWithTimeout, imageUrl, options = {}) {
    const attempts = options.attempts || DEFAULT_ATTEMPTS;
    const delayMs = options.delayMs !== undefined ? options.delayMs : DEFAULT_DELAY_MS;

    let last = { ok: false, status: null, reason: "network", metadata: null, attempts: 0 };

    if (!isAllowedMetadataUrl(imageUrl)) {
        return {
            ok: false,
            status: null,
            reason: "blocked",
            metadata: null,
            attempts: 0
        };
    }

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await fetchWithTimeout(imageUrl, {}, 20000);

            if (response.ok) {
                const buffer = Buffer.from(await response.arrayBuffer());

                try {
                    return {
                        ok: true,
                        status: response.status,
                        reason: null,
                        metadata: decodeMetadata(buffer),
                        attempts: attempt
                    };
                } catch {
                    last = {
                        ok: false,
                        status: response.status,
                        reason: "invalid",
                        metadata: null,
                        attempts: attempt
                    };
                }
            } else {
                last = {
                    ok: false,
                    status: response.status,
                    reason: "http",
                    metadata: null,
                    attempts: attempt
                };

                if (!RETRYABLE_STATUS.has(response.status)) {
                    return last;
                }
            }
        } catch (error) {
            last = {
                ok: false,
                status: null,
                reason: "network",
                metadata: null,
                attempts: attempt,
                error
            };
        }

        if (attempt < attempts) {
            console.warn(
                `Avatar metadata JSON not ready (attempt ${attempt}/${attempts}). Retrying...`
            );
            await sleep(delayMs);
        }
    }

    return last;
}

module.exports = {
    DEFAULT_ATTEMPTS,
    fetchAvatar3D,
    fetchAvatarMetadataJson,
    fetchPlayerAvatar,
    isAllowedMetadataUrl
};
