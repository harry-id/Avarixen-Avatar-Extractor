"use strict";

// Small, dependency-free configuration parsers. Keeping these pure makes the
// edge cases (notably TRUST_PROXY=false) testable without starting a server.

/**
 * Parse the TRUST_PROXY environment value for Express.
 *
 * Returns:
 *   undefined  -> leave Express's default (no proxy trust)
 *   false      -> explicitly do not trust a proxy
 *   number     -> hop count (e.g. "1")
 *   string     -> CIDR / subnet list (e.g. "loopback, 10.0.0.0/8")
 *
 * Previously the literal string "false" reached Express, which treats any
 * string as an IP/CIDR and throws "invalid IP address: false" at startup.
 */
function parseTrustProxy(value) {
    if (value === undefined || value === null) {
        return undefined;
    }

    const raw = String(value).trim();

    if (!raw) {
        return undefined;
    }

    const lower = raw.toLowerCase();

    if (["false", "0", "off", "no", "none"].includes(lower)) {
        return false;
    }

    if (lower === "true") {
        return true;
    }

    if (/^\d+$/.test(raw)) {
        return Number(raw);
    }

    return raw;
}

/**
 * Resolve TRUST_PROXY into a safe runtime mode.
 *
 * `true` trusts every forwarding header from every peer, so it is never safe
 * for a public deployment. In production it fails startup; outside production
 * it is downgraded to no proxy trust with a warning.
 *
 * `cloudflare` is the safe Cloudflare Tunnel mode: CF-Connecting-IP is only
 * accepted when the direct TCP peer is loopback (the local cloudflared
 * process), otherwise the socket address is used.
 */
function resolveTrustProxy(value, { production = false } = {}) {
    const parsed = parseTrustProxy(value);

    if (parsed === true) {
        if (production) {
            throw new Error(
                "TRUST_PROXY=true trusts arbitrary X-Forwarded-For headers and is not allowed in production. " +
                "Use TRUST_PROXY=cloudflare for Cloudflare Tunnel, a trusted hop count, or a proxy CIDR list."
            );
        }

        return {
            mode: "cloudflare",
            value: false,
            apply: true,
            warning:
                "TRUST_PROXY=true is unsafe as a general setting; treating it as Cloudflare mode. " +
                "Use TRUST_PROXY=cloudflare explicitly and set NODE_ENV=production."
        };
    }

    if (typeof parsed === "string" && ["cloudflare", "cf", "cf-tunnel"].includes(parsed.toLowerCase())) {
        return { mode: "cloudflare", value: false, apply: true, warning: null };
    }

    if (parsed === undefined) {
        return { mode: "none", value: undefined, apply: false, warning: null };
    }

    return { mode: "express", value: parsed, apply: true, warning: null };
}

/**
 * Bind address. Defaults to loopback so a bare `node server.js` does not
 * accidentally expose the API on every interface. Set HOST=0.0.0.0 explicitly
 * when direct public binding is intended.
 */
function resolveHost(value, fallback = "127.0.0.1") {
    if (value === undefined || value === null || String(value).trim() === "") {
        return fallback;
    }

    const host = String(value).trim();

    if (/[\s/]/.test(host)) {
        throw new Error("HOST must be an address or hostname without spaces or slashes");
    }

    return host;
}

function resolveCorsOrigins(value, { production = false } = {}) {
    const origins = String(value || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

    if (!origins.length && production) {
        throw new Error(
            "CORS_ORIGINS must be set in production. Wildcard CORS is not allowed for a public deployment."
        );
    }

    if (production && origins.includes("*")) {
        throw new Error("CORS_ORIGINS must not contain '*' in production.");
    }

    return origins;
}


/**
 * Parse a strictly positive number, falling back when the value is missing,
 * non-numeric, or <= 0. Used for TTL-style settings where a negative value
 * would otherwise make the cleanup sweep delete every cached avatar at once.
 */
function parsePositiveNumber(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return fallback;
    }

    const number = Number(value);

    return Number.isFinite(number) && number > 0 ? number : fallback;
}

/**
 * Parse a non-negative number (0 is meaningful, e.g. "no byte quota").
 */
function parseNonNegativeNumber(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return fallback;
    }

    const number = Number(value);

    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * Parse a boolean-ish environment value, falling back when the value is
 * missing, empty, non-boolean-like, or unrecognized. Used for opt-in features
 * (e.g. AAE_PROFILE_STAGES) that default to disabled.
 */
function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null) {
        return fallback;
    }

    const raw = String(value).trim();

    if (!raw) {
        return fallback;
    }

    const lower = raw.toLowerCase();

    if (["true", "1", "yes", "on"].includes(lower)) {
        return true;
    }

    if (["false", "0", "no", "off", "none"].includes(lower)) {
        return false;
    }

    return fallback;
}

module.exports = {
    parsePositiveNumber,
    parseNonNegativeNumber,
    parseBoolean,
    parseTrustProxy,
    resolveTrustProxy,
    resolveHost,
    resolveCorsOrigins
};
