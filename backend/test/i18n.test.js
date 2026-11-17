"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { getLang, t, DEFAULT_LANG } = require("../i18n");

test("getLang honours Accept-Language and falls back to Indonesian", () => {
    assert.equal(getLang({ headers: { "accept-language": "en-US,en;q=0.9" } }), "en");
    assert.equal(getLang({ headers: { "accept-language": "id-ID" } }), "id");
    assert.equal(getLang({ headers: {} }), DEFAULT_LANG);
    assert.equal(getLang({ headers: { "accept-language": "fr-FR" } }), DEFAULT_LANG);
});

test("t substitutes {{message}} placeholders", () => {
    assert.equal(
        t("en", "convert.rig_failed").replace("{{message}}", "boom"),
        "Auto-rig failed: boom"
    );
});

test("t returns the key when a message is missing", () => {
    assert.equal(t("en", "missing.key"), "missing.key");
});
