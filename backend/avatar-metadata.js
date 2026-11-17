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

function resolveImageUrl(result) {
    return result?.data?.[0]?.imageUrl || result?.imageUrl || null;
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
    fetchAvatarMetadataJson
};
