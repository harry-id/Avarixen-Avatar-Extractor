require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { getLang, t } = require("./i18n");
const { fetchAvatar3D } = require("./avatar-metadata");
const { version: APP_VERSION } = require("./package.json");
const { startDownloadsCleanup } = require("./downloads-cleanup");

const app = express();
const PORT = process.env.PORT || 3000;

const corsOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(
    cors(
        corsOrigins.length
            ? { origin: corsOrigins, methods: ["GET", "POST", "OPTIONS"] }
            : undefined
    )
);
app.use(express.json({ limit: "16kb" }));

// Set TRUST_PROXY (e.g. "1", "true", or a proxy CIDR list) when the API runs
// behind a reverse proxy so per-client rate limiting sees the real client IP.
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) {
    app.set(
        "trust proxy",
        /^\d+$/.test(trustProxy)
            ? Number(trustProxy)
            : trustProxy === "true"
                ? true
                : trustProxy
    );
}

// Serve cached avatar files (OBJ/MTL/textures) for the 3D preview and the
// client-side OBJ download. In production this lets the GitHub Pages frontend
// load assets from the API origin (api.harrycore.web.id).
const downloadsDir = path.join(__dirname, "../downloads");
app.use("/assets", express.static(downloadsDir));

// Delete cached avatars older than DOWNLOADS_TTL_HOURS (default 24h) so the
// cache does not grow without bound. The timer is unref'd, so it never keeps
// the process alive on its own.
const downloadsTtlHours = Number(process.env.DOWNLOADS_TTL_HOURS) || 24;
const downloadsCleanup = startDownloadsCleanup({
    dir: downloadsDir,
    maxAgeMs: downloadsTtlHours * 60 * 60 * 1000
});

const rateWindowMs = 60_000;
const rateMax = 60;
const rateBuckets = new Map();

// Drop expired buckets so the map cannot grow without bound.
const ratePruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateBuckets) {
        if (now > bucket.resetAt) {
            rateBuckets.delete(ip);
        }
    }
}, rateWindowMs);

ratePruneTimer.unref();

app.use("/api", (req, res, next) => {
    if (req.method === "OPTIONS") {
        return next();
    }

    const lang = getLang(req);
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const bucket = rateBuckets.get(ip);

    if (!bucket || now > bucket.resetAt) {
        rateBuckets.set(ip, { count: 1, resetAt: now + rateWindowMs });
        return next();
    }

    bucket.count += 1;
    if (bucket.count > rateMax) {
        const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        res.set("Retry-After", String(retryAfter));
        return res.status(429).json({
            success: false,
            message: t(lang, "rate_limited")
        });
    }

    next();
});

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

function getApiKey() {
    const apiKey = process.env.ROBLOX_API_KEY;
    if (!apiKey || apiKey === "your_roblox_api_key_here") {
        return null;
    }
    return apiKey;
}

require("./avatar-downloader")(app, { fetchWithTimeout, getApiKey });
require("./convert")(app);

app.get("/", (req, res) => {
    res.json({
        status: "online",
        name: "Avarixen Avatar Extractor",
        version: APP_VERSION
    });
});

// Lightweight health probe used by the frontend status badge.
app.get("/api/health", (req, res) => {
    res.json({ status: "online" });
});

// Pencarian username Roblox
app.post("/api/roblox/user", async (req, res) => {
    const lang = getLang(req);

    try {
        const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";

        if (!username) {
            return res.status(400).json({
                success: false,
                message: t(lang, "user.empty")
            });
        }

        if (username.length > 20) {
            return res.status(400).json({
                success: false,
                message: t(lang, "user.invalid")
            });
        }

        const response = await fetchWithTimeout(
            "https://users.roblox.com/v1/usernames/users",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    usernames: [username],
                    excludeBannedUsers: true
                })
            }
        );

        if (!response.ok) {
            return res.status(502).json({
                success: false,
                message: t(lang, "user.upstream_failed")
            });
        }

        const result = await response.json();

        if (!Array.isArray(result.data) || result.data.length === 0) {
            return res.status(404).json({
                success: false,
                message: t(lang, "user.not_found")
            });
        }

        const user = result.data[0];

        res.json({
            success: true,
            user: {
                id: user.id,
                username: user.name,
                displayName: user.displayName
            }
        });

    } catch (error) {
        console.error("Roblox user lookup failed:", error);
        const isTimeout = error && error.name === "AbortError";
        res.status(isTimeout ? 504 : 500).json({
            success: false,
            message: isTimeout
                ? t(lang, "user.timeout")
                : t(lang, "user.lookup_failed")
        });
    }
});

// Pengambilan Avatar 3D
app.get("/api/roblox/avatar/:userId", async (req, res) => {
    const lang = getLang(req);

    try {
        const { userId } = req.params;

        if (!/^\d+$/.test(userId)) {
            return res.status(400).json({
                success: false,
                message: t(lang, "avatar.invalid_user_id")
            });
        }

        const apiKey = getApiKey();

        if (!apiKey) {
            return res.status(500).json({
                success: false,
                message: t(lang, "avatar.not_configured")
            });
        }

        const metadata = await fetchAvatar3D(
            fetchWithTimeout,
            apiKey,
            userId
        );

        if (!metadata.ok) {
            console.error(
                "Roblox avatar API failed:",
                metadata.status,
                `after ${metadata.attempts} attempt(s)`
            );
            return res.status(502).json({
                success: false,
                message: t(lang, "avatar.upstream_failed")
            });
        }

        res.json({
            success: true,
            avatar: metadata.result
        });

    } catch (error) {
        console.error("Avatar metadata request failed:", error);
        const isTimeout = error && error.name === "AbortError";
        res.status(isTimeout ? 504 : 500).json({
            success: false,
            message: isTimeout
                ? t(lang, "avatar.timeout")
                : t(lang, "avatar.failed")
        });
    }
});

const server = app.listen(PORT);

server.on("listening", () => {
    console.log(`AAE Server running on port ${PORT}`);
});

server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        console.error(
            `AAE Server failed: port ${PORT} is already in use. ` +
            `Stop the process using it (or set PORT to a free port) and try again.`
        );
    } else {
        console.error("AAE Server failed to start:", error.message);
    }

    process.exit(1);
});

let shuttingDown = false;

function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);

    downloadsCleanup.stop();

    server.close(() => process.exit(0));

    // Do not hang forever if keep-alive connections stay open.
    setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
