"use strict";

const net = require("net");

function isLoopbackAddress(value) {
    if (typeof value !== "string") {
        return false;
    }

    let address = value.trim().toLowerCase();

    if (address.startsWith("::ffff:")) {
        address = address.slice(7);
    }

    if (address === "::1" || address === "0:0:0:0:0:0:0:1") {
        return true;
    }

    return net.isIP(address) === 4 && address.startsWith("127.");
}

function validIp(value) {
    return typeof value === "string" && net.isIP(value.trim()) !== 0
        ? value.trim()
        : null;
}

/**
 * Return the client identity used by logging and rate limiting.
 *
 * - `none`: socket address.
 * - `express`: trust proxy was explicitly configured; Express's req.ip is
 *   already the validated client address.
 * - `cloudflare`: accept CF-Connecting-IP only when the TCP peer is loopback
 *   (the local cloudflared process). A direct client cannot spoof it.
 */
function getClientIp(req, mode = "none") {
    const socketAddress =
        (req.socket && req.socket.remoteAddress) ||
        req.ip ||
        "unknown";

    if (mode !== "cloudflare") {
        return req.ip || socketAddress;
    }

    if (!isLoopbackAddress(socketAddress)) {
        return socketAddress;
    }

    const forwarded = validIp(req.headers && req.headers["cf-connecting-ip"]);
    return forwarded || socketAddress;
}

module.exports = {
    isLoopbackAddress,
    getClientIp
};
