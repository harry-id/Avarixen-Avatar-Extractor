require("dotenv").config();

// Start file logging before anything else logs. Tees console output to a log
// file (ANSI stripped); disable with AAE_LOG_FILE=false.
const { initLogger } = require("./logger");
const logTarget = initLogger();
if (logTarget.enabled) {
    console.log(`[log] file logging enabled: ${logTarget.filePath}`);
}

const express = require("express");
const cors = require("cors");
const path = require("path");
const { getLang, t } = require("./i18n");
const { fetchAvatar3D } = require("./avatar-metadata");
const { version: APP_VERSION } = require("./package.json");
const { startDownloadsCleanup } = require("./downloads-cleanup");
const { fetchWithTimeout } = require("./fetch-utils");
const { isUserLocked } = require("./user-lock");
const {
    parseNonNegativeNumber,
    parsePositiveNumber,
    resolveTrustProxy,
    resolveHost,
    resolveCorsOrigins
} = require("./config");
const { getClientIp } = require("./client-identity");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = resolveHost(process.env.HOST);
const isProduction = process.env.NODE_ENV === "production";

// Safe defaults: the cache is finite even when the environment forgets to set
// a quota, and downloads stop before the filesystem becomes critically full.
const DEFAULT_DOWNLOADS_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MIN_FREE_DISK_BYTES = 512 * 1024 * 1024;

// Keep Express's default error handler from exposing stack traces when the
// deployment does not set NODE_ENV explicitly.
if (!process.env.NODE_ENV) {
    app.set("env", "production");
}

app.disable("x-powered-by");

const corsOrigins = resolveCorsOrigins(process.env.CORS_ORIGINS, {
    production: isProduction
});

if (!corsOrigins.length) {
    console.warn(
        "[cors] CORS_ORIGINS is not set; allowing any origin in development. " +
        "Set explicit origins in production to limit API consumption."
    );
}

app.use(
    cors(
        corsOrigins.length
            ? { origin: corsOrigins, methods: ["GET", "POST", "OPTIONS"], maxAge: 86400 }
            : undefined
    )
);
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    next();
});

app.use(express.json({ limit: "16kb" }));

// Set TRUST_PROXY (e.g. "1", a proxy CIDR list, or "cloudflare") when the API
// runs behind a reverse proxy. TRUST_PROXY=true is rejected in production and
// downgraded to socket addresses elsewhere; it trusts arbitrary forwarding
// headers and therefore cannot be used for rate limiting.
const clientIdentity = resolveTrustProxy(process.env.TRUST_PROXY, {
    production: isProduction
});

if (clientIdentity.warning) {
    console.warn(`[proxy] ${clientIdentity.warning}`);
}

if (clientIdentity.apply) {
    try {
        app.set("trust proxy", clientIdentity.value);
    } catch (error) {
        throw new Error(`Invalid TRUST_PROXY configuration: ${error.message}`);
    }
}

// Request logging: colored, fixed-width lines. Set LOG_REQUESTS=false to
// disable, or LOG_REQUESTS=verbose to also log request bodies and user agents.
const logRequests = process.env.LOG_REQUESTS !== "false";
const logVerbose = process.env.LOG_REQUESTS === "verbose" && !isProduction;

const LOG_RESET = "\x1b[0m";
const LOG_DIM = "\x1b[2m";
const LOG_GREEN = "\x1b[32m";

function logTimestamp(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return (
        `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} - ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
}

function logDuration(ms) {
    if (ms < 1) return `${(ms * 1000).toFixed(3)}µs`;
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

function logMethodColor(method) {
    switch (method) {
        case "GET": return "\x1b[34m";
        case "POST": return "\x1b[36m";
        case "PUT": return "\x1b[33m";
        case "DELETE": return "\x1b[31m";
        case "PATCH": return "\x1b[32m";
        case "HEAD": return "\x1b[35m";
        case "OPTIONS": return "\x1b[37m";
        default: return LOG_RESET;
    }
}

if (logRequests) {
    app.use((req, res, next) => {
        const start = process.hrtime.bigint();
        const ip = getClientIp(req, clientIdentity.mode) || "-";

        if (logVerbose) {
            const ua = req.get("user-agent") || "-";
            const body = req.body && Object.keys(req.body).length
                ? ` body=${JSON.stringify(req.body)}`
                : "";
            console.log(
                `${LOG_GREEN}[AAE]${LOG_RESET} ${LOG_DIM}[req]${LOG_RESET} ` +
                `${logMethodColor(req.method)}${req.method}${LOG_RESET} ` +
                `${req.originalUrl} ua="${ua}"${body}`
            );
        }

        res.on("finish", () => {
            // Routine access logs stay quiet for successful health probes
            // (uptime monitors); failed health checks are still logged.
            const isSuccessfulHealth =
                req.method === "GET" &&
                req.originalUrl === "/api/health" &&
                res.statusCode >= 200 &&
                res.statusCode < 300;

            if (isSuccessfulHealth) {
                return;
            }

            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            const statusColor =
                res.statusCode >= 500 ? "\x1b[31m" :
                res.statusCode >= 400 ? "\x1b[33m" :
                res.statusCode >= 300 ? "\x1b[36m" :
                "\x1b[32m";
            const latency = logDuration(ms).padStart(8);
            const ipPadded = ip.padStart(15);
            const method = req.method.padEnd(7);

            console.log(
                `${LOG_GREEN}[AAE]${LOG_RESET} ${LOG_DIM}${logTimestamp(new Date())}${LOG_RESET} | ` +
                `${statusColor}${res.statusCode}${LOG_RESET} | ` +
                `${LOG_DIM}${latency}${LOG_RESET} | ` +
                `${LOG_DIM}${ipPadded}${LOG_RESET} | ` +
                `${logMethodColor(req.method)}${method}${LOG_RESET}  "${req.originalUrl}"`
            );
        });

        next();
    });
    console.log(`[log] request logging enabled${logVerbose ? " (verbose)" : ""}`);
} else {
    console.log("[log] request logging disabled");
}

// Serve cached avatar files (OBJ/MTL/textures) for the 3D preview and the
// client-side OBJ download. In production this lets the GitHub Pages frontend
// load assets from the API origin (api.harrycore.web.id).
const downloadsDir = path.join(__dirname, "../downloads");

// Revalidate assets (no-cache) so re-downloaded avatars aren't served stale;
// short max-age keeps repeat loads fast.
app.use(
    "/assets",
    express.static(downloadsDir, {
        etag: true,
        lastModified: true,
        maxAge: "5m",
        setHeaders(res) {
            res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
        }
    })
);

// Delete cached avatars older than DOWNLOADS_TTL_HOURS (default 24h) so the
// cache does not grow without bound. The timer is unref'd, so it never keeps
// the process alive on its own.
const downloadsTtlHours = parsePositiveNumber(process.env.DOWNLOADS_TTL_HOURS, 24);
const downloadsMaxBytes = parseNonNegativeNumber(
    process.env.DOWNLOADS_MAX_BYTES,
    DEFAULT_DOWNLOADS_MAX_BYTES
);
const minFreeDiskBytes = parseNonNegativeNumber(
    process.env.MIN_FREE_DISK_BYTES,
    DEFAULT_MIN_FREE_DISK_BYTES
);
const downloadsCleanup = startDownloadsCleanup({
    dir: downloadsDir,
    maxAgeMs: downloadsTtlHours * 60 * 60 * 1000,
    maxBytes: downloadsMaxBytes,
    // Never delete a user's cache (or its staging/backup directory) while a
    // download/conversion for that user is in progress.
    shouldSkip: (fullPath, name) => {
        if (isUserLocked(name)) {
            return true;
        }

        const match = /^\.(?:stage|old)-(\d+)-/.exec(name);
        return match ? isUserLocked(match[1]) : false;
    }
});

const rateWindowMs = parsePositiveNumber(
    process.env.RATE_LIMIT_WINDOW_MS,
    60_000
);
const rateMax = parsePositiveNumber(process.env.RATE_LIMIT_MAX, 60);
const rateBuckets = new Map();

// API responses are user/avatar-specific and some are downloads: never let an
// intermediary cache them.
app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
});

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
    const ip = getClientIp(req, clientIdentity.mode) || "unknown";
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

function getApiKey() {
    const apiKey = process.env.ROBLOX_API_KEY;
    if (!apiKey || apiKey === "your_roblox_api_key_here") {
        return null;
    }
    return apiKey;
}

require("./avatar-downloader")(app, {
    fetchWithTimeout,
    getApiKey,
    downloadsMaxBytes,
    minFreeDiskBytes
});
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
    res.json({ status: "online", version: APP_VERSION });
});

app.post("/api/roblox/user", async (req, res) => {
    const lang = getLang(req);

    try {
        const query = typeof req.body?.username === "string" ? req.body.username.trim() : "";

        if (!query) {
            return res.status(400).json({
                success: false,
                message: t(lang, "user.empty")
            });
        }

        // A numeric query is a Roblox user ID; look it up directly.
        if (/^\d+$/.test(query)) {
            const idResponse = await fetchWithTimeout(
                `https://users.roblox.com/v1/users/${encodeURIComponent(query)}`,
                { headers: { "Content-Type": "application/json" } }
            );

            if (!idResponse.ok) {
                return res.status(idResponse.status === 404 ? 404 : 502).json({
                    success: false,
                    message: t(
                        lang,
                        idResponse.status === 404 ? "user.not_found" : "user.upstream_failed"
                    )
                });
            }

            const account = await idResponse.json();

            if (!account || !account.id) {
                return res.status(404).json({
                    success: false,
                    message: t(lang, "user.not_found")
                });
            }

            return res.json({
                success: true,
                user: {
                    id: account.id,
                    username: account.name,
                    displayName: account.displayName
                }
            });
        }

        if (query.length > 20) {
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
                    usernames: [query],
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

// JSON 404 for unknown API routes (the frontend expects the API error shape).
app.use("/api", (req, res) => {
    res.status(404).json({
        success: false,
        message: t(getLang(req), "error.not_found")
    });
});

// Final error handler: never expose stack traces or internals to clients.
app.use((error, req, res, next) => {
    console.error("Unhandled request error:", error);

    if (res.headersSent) {
        return next(error);
    }

    const status =
        error && Number.isInteger(error.status) && error.status >= 400 && error.status < 600
            ? error.status
            : 500;
    const key = status >= 500 ? "error.internal" : "error.bad_request";

    res.status(status).json({
        success: false,
        message: t(getLang(req), key)
    });
});

const server = app.listen(PORT, HOST);

// Bound slow/incomplete clients so a few stalled connections cannot hold
// resources indefinitely. Outbound Roblox/CDN requests have their own limits.
server.requestTimeout = parsePositiveNumber(
    process.env.REQUEST_TIMEOUT_MS,
    120_000
);
server.headersTimeout = parsePositiveNumber(
    process.env.HEADERS_TIMEOUT_MS,
    30_000
);
server.keepAliveTimeout = parsePositiveNumber(
    process.env.KEEP_ALIVE_TIMEOUT_MS,
    65_000
);

server.on("listening", () => {
    console.log(`AAE Server running at http://${HOST}:${PORT}`);
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
