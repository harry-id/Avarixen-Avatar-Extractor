import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_LANG, LANG, getCurrentLang, setLang, t } from "../i18n.mjs";

test("existing translation lookup returns English values", () => {
    assert.equal(t("appTitle"), "Avarixen");
    assert.equal(t("appSubtitle"), "Roblox Avatar Downloader & 3D Exporter");
    assert.equal(t("statusWaiting"), "Enter a Roblox username to load 3D preview.");
});

test("indonesian translations are preserved for the id language", () => {
    setLang("id");
    assert.equal(t("statusWaiting"), "Masukkan username Roblox untuk memuat pratinjau 3D.");
    assert.equal(t("appTitle"), "Avarixen");
    setLang(DEFAULT_LANG);
});

test("missing translation keys fall back to the key itself", () => {
    assert.equal(t("definitelyMissingKey"), "definitelyMissingKey");
});

test("dynamic interpolation replaces placeholders with provided values", () => {
    assert.equal(t("errorOccurred", { message: "boom" }), "An error occurred: boom");
    assert.equal(t("errorZipFetch", { file: "avatar.obj" }), "Failed to fetch avatar.obj");
    assert.equal(t("statusConverting", { format: "GLB" }), "Converting model to GLB...");
});

test("dynamic interpolation keeps placeholders when no value is provided", () => {
    assert.equal(t("errorOccurred", {}), "An error occurred: {{message}}");
});

test("default language is english", () => {
    assert.equal(DEFAULT_LANG, "en");
    assert.equal(getCurrentLang(), "en");
});

test("setLang updates the current language", () => {
    setLang("id");
    assert.equal(getCurrentLang(), "id");
    setLang(DEFAULT_LANG);
    assert.equal(getCurrentLang(), "en");
});
