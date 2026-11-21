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

module.exports = {
    parsePositiveNumber,
    parseNonNegativeNumber,
    parseTrustProxy
};
