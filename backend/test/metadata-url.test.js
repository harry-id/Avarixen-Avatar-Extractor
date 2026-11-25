"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { isAllowedMetadataUrl } = require("../avatar-metadata");

test("metadata URLs are limited to Roblox HTTPS hosts", () => {
    assert.equal(isAllowedMetadataUrl("https://tr.rbxcdn.com/abc/def"), true);
    assert.equal(isAllowedMetadataUrl("https://c0.rbxcdn.com/abc"), true);
    assert.equal(isAllowedMetadataUrl("https://thumbnails.roblox.com/v1/x"), true);
    assert.equal(isAllowedMetadataUrl("https://users.roblox.com/v1/users/1"), true);
});

test("metadata URLs reject non-Roblox hosts, protocols, and malformed input", () => {
    assert.equal(isAllowedMetadataUrl("http://tr.rbxcdn.com/abc"), false);
    assert.equal(isAllowedMetadataUrl("https://evil.example.com/abc"), false);
    assert.equal(isAllowedMetadataUrl("https://evilrbxcdn.com/abc"), false);
    assert.equal(isAllowedMetadataUrl("https://rbxcdn.com.evil.test/abc"), false);
    assert.equal(isAllowedMetadataUrl("file:///etc/passwd"), false);
    assert.equal(isAllowedMetadataUrl("https://127.0.0.1/abc"), false);
    assert.equal(isAllowedMetadataUrl(""), false);
    assert.equal(isAllowedMetadataUrl(null), false);
    assert.equal(isAllowedMetadataUrl("not a url"), false);
});

test("metadata URLs allow only the default HTTPS port", () => {
    // :443 is normalized away by new URL(), so it is equivalent to no port.
    assert.equal(isAllowedMetadataUrl("https://tr.rbxcdn.com:443/abc"), true);
    assert.equal(isAllowedMetadataUrl("https://tr.rbxcdn.com:22/abc"), false);
    assert.equal(isAllowedMetadataUrl("https://roblox.com:8443/x"), false);
    assert.equal(isAllowedMetadataUrl("https://t0.rbxcdn.com:0/hash"), false);
});

test("metadata decompression is bounded", () => {
    const zlib = require("zlib");
    const { decodeMetadata } = require("../avatar-metadata");

    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify({
        obj: "x".repeat(2048)
    })));

    assert.throws(
        () => decodeMetadata(compressed, 64),
        /size limit/
    );
});
