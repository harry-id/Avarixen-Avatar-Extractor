import { test } from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_FORMAT_SUPPORT,
    FORMAT_OPTION_SUPPORT,
    isFormatOptionSupported
} from "../format-support.mjs";

test("OBJ export supports geometry only (no rig, no separate assets)", () => {
    assert.equal(FORMAT_OPTION_SUPPORT.obj.rig, false);
    assert.equal(FORMAT_OPTION_SUPPORT.obj.separate, false);
});

test("GLB export always embeds a single file and supports the rig", () => {
    assert.equal(FORMAT_OPTION_SUPPORT.glb.rig, true);
    assert.equal(FORMAT_OPTION_SUPPORT.glb.separate, false);
});

test("GLTF export supports both the rig and separate assets", () => {
    assert.equal(FORMAT_OPTION_SUPPORT.gltf.rig, true);
    assert.equal(FORMAT_OPTION_SUPPORT.gltf.separate, true);
});

test("FBX export supports both the rig and separate assets", () => {
    assert.equal(FORMAT_OPTION_SUPPORT.fbx.rig, true);
    assert.equal(FORMAT_OPTION_SUPPORT.fbx.separate, true);
});

test("isFormatOptionSupported reflects the capability matrix", () => {
    assert.equal(isFormatOptionSupported("obj", "rig"), false);
    assert.equal(isFormatOptionSupported("obj", "separate"), false);
    assert.equal(isFormatOptionSupported("glb", "rig"), true);
    assert.equal(isFormatOptionSupported("glb", "separate"), false);
    assert.equal(isFormatOptionSupported("gltf", "rig"), true);
    assert.equal(isFormatOptionSupported("gltf", "separate"), true);
    assert.equal(isFormatOptionSupported("fbx", "rig"), true);
    assert.equal(isFormatOptionSupported("fbx", "separate"), true);
});

test("unknown formats fall back to the default full support", () => {
    assert.equal(isFormatOptionSupported("unknown", "rig"), true);
    assert.equal(isFormatOptionSupported("unknown", "separate"), true);
});

test("default format support enables rig and separate assets", () => {
    assert.equal(DEFAULT_FORMAT_SUPPORT.rig, true);
    assert.equal(DEFAULT_FORMAT_SUPPORT.separate, true);
});
