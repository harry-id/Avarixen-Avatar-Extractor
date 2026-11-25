"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const {
    parseNonNegativeNumber,
    parsePositiveNumber,
    parseTrustProxy,
    resolveTrustProxy
} = require("../config");

test("parseTrustProxy accepts booleans, hop counts, and CIDR lists", () => {
    assert.equal(parseTrustProxy("true"), true);
    assert.equal(parseTrustProxy("1"), 1);
    assert.equal(parseTrustProxy("loopback, 10.0.0.0/8"), "loopback, 10.0.0.0/8");
    assert.equal(parseTrustProxy(undefined), undefined);
    assert.equal(parseTrustProxy(""), undefined);
});

test("parseTrustProxy treats false-like values as disabled", () => {
    for (const value of ["false", "FALSE", "0", "off", "no", "none"]) {
        assert.equal(parseTrustProxy(value), false);
    }
});

test("TRUST_PROXY=false no longer makes Express throw", () => {
    const app = express();
    const parsed = parseTrustProxy("false");

    assert.doesNotThrow(() => app.set("trust proxy", parsed));
    assert.equal(app.get("trust proxy"), false);
});

test("parsePositiveNumber falls back for zero, negative, and junk values", () => {
    assert.equal(parsePositiveNumber("12", 24), 12);
    assert.equal(parsePositiveNumber("-1", 24), 24);
    assert.equal(parsePositiveNumber("0", 24), 24);
    assert.equal(parsePositiveNumber("abc", 24), 24);
    assert.equal(parsePositiveNumber(undefined, 24), 24);
});

test("parseNonNegativeNumber keeps zero but rejects negatives", () => {
    assert.equal(parseNonNegativeNumber("0", 8), 0);
    assert.equal(parseNonNegativeNumber("5", 8), 5);
    assert.equal(parseNonNegativeNumber("-5", 8), 8);
    assert.equal(parseNonNegativeNumber("junk", 8), 8);
});

test("TRUST_PROXY=true outside production resolves to Cloudflare mode", () => {
    const resolved = resolveTrustProxy("true", { production: false });

    assert.equal(resolved.mode, "cloudflare");
    assert.equal(resolved.apply, true);
    assert.equal(resolved.value, false);
    assert.ok(resolved.warning);
});

test("TRUST_PROXY=true is rejected in production", () => {
    assert.throws(
        () => resolveTrustProxy("true", { production: true }),
        /not allowed in production/
    );
});
