"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { resolveTrustProxy, resolveHost } = require("../config");
const { getClientIp, isLoopbackAddress } = require("../client-identity");

test("TRUST_PROXY=true is rejected in production and downgraded elsewhere", () => {
    assert.throws(
        () => resolveTrustProxy("true", { production: true }),
        /TRUST_PROXY=true/
    );

    const dev = resolveTrustProxy("true", { production: false });
    assert.equal(dev.mode, "cloudflare");
    assert.equal(dev.value, false);
    assert.match(dev.warning, /unsafe/);
});

test("trusted proxy modes are explicit", () => {
    const cf = resolveTrustProxy("cloudflare");
    assert.equal(cf.mode, "cloudflare");
    assert.equal(cf.value, false);

    const hop = resolveTrustProxy("1");
    assert.equal(hop.mode, "express");
    assert.equal(hop.value, 1);

    const disabled = resolveTrustProxy("false");
    assert.equal(disabled.mode, "express");
    assert.equal(disabled.value, false);

    assert.equal(resolveTrustProxy(undefined).mode, "none");
});

test("Cloudflare client identity is only trusted from a loopback peer", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLoopbackAddress("203.0.113.10"), false);

    const loopbackReq = {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "cf-connecting-ip": "198.51.100.7" }
    };
    assert.equal(getClientIp(loopbackReq, "cloudflare"), "198.51.100.7");

    const directReq = {
        socket: { remoteAddress: "203.0.113.10" },
        headers: { "cf-connecting-ip": "198.51.100.7" }
    };
    assert.equal(getClientIp(directReq, "cloudflare"), "203.0.113.10");

    const invalidReq = {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "cf-connecting-ip": "not-an-ip" }
    };
    assert.equal(getClientIp(invalidReq, "cloudflare"), "127.0.0.1");
});

test("untrusted forwarding headers do not change req.ip", async () => {
    const app = express();
    app.set("trust proxy", false);
    app.get("/", (req, res) => res.json({ ip: req.ip }));

    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));

    try {
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}/`,
            { headers: { "X-Forwarded-For": "198.51.100.9" } }
        );
        const body = await response.json();
        assert.match(body.ip, /^127\.0\.0\.1$|^::ffff:127\.0\.0\.1$/);
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test("HOST defaults to loopback and rejects malformed values", () => {
    assert.equal(resolveHost(undefined), "127.0.0.1");
    assert.equal(resolveHost("0.0.0.0"), "0.0.0.0");
    assert.equal(resolveHost("10.0.0.5"), "10.0.0.5");
    assert.throws(() => resolveHost("bad host"), /HOST/);
});

test("CORS fails closed in production but stays convenient in development", () => {
    const { resolveCorsOrigins } = require("../config");

    assert.deepEqual(resolveCorsOrigins("https://a.test, https://b.test"), [
        "https://a.test",
        "https://b.test"
    ]);
    assert.deepEqual(resolveCorsOrigins(""), []);
    assert.throws(
        () => resolveCorsOrigins("", { production: true }),
        /CORS_ORIGINS/
    );
    assert.throws(
        () => resolveCorsOrigins("*", { production: true }),
        /\*/ 
    );
});
