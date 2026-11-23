import { test } from "node:test";
import assert from "node:assert/strict";

import {
    DEFAULT_OBJ_ASSET_FILES,
    objMtlFileNames,
    resolveAssetFiles,
    sanitizeExportName,
    zipEntryName
} from "../naming.mjs";

test("sanitizeExportName strips characters that are unsafe in file names", () => {
    assert.equal(sanitizeExportName("bad\\name", "Avarixen"), "bad_name");
    assert.equal(sanitizeExportName("bad:name", "Avarixen"), "bad_name");
});

test("sanitizeExportName trims trailing dots and spaces", () => {
    assert.equal(sanitizeExportName("Avatar. ", "Avarixen"), "Avatar");
});

test("sanitizeExportName falls back to the fallback when input is empty", () => {
    assert.equal(sanitizeExportName("", "Avarixen"), "Avarixen");
    assert.equal(sanitizeExportName(null, "Avarixen"), "Avarixen");
    assert.equal(sanitizeExportName("   ", "Avarixen"), "Avarixen");
});

test("resolveAssetFiles defaults to the OBJ/MTL pair without a file list", () => {
    assert.deepEqual(resolveAssetFiles(null), ["avatar.obj", "avatar.mtl"]);
    assert.deepEqual(resolveAssetFiles([]), ["avatar.obj", "avatar.mtl"]);
});

test("resolveAssetFiles maps backend-reported paths to bare file names", () => {
    assert.deepEqual(
        resolveAssetFiles([
            "avatars/123/torso/avatar.obj",
            "avatars/123/torso/avatar.mtl"
        ]),
        ["avatar.obj", "avatar.mtl"]
    );
});

test("objMtlFileNames lowercases the base name and appends the extension", () => {
    assert.deepEqual(objMtlFileNames("Avatar 2"), { obj: "avatar 2.obj", mtl: "avatar 2.mtl" });
    assert.deepEqual(objMtlFileNames("Avarixen"), { obj: "avarixen.obj", mtl: "avarixen.mtl" });
});

test("zipEntryName prefixes the sanitized display name into the archive", () => {
    assert.equal(zipEntryName("Avatar 2", "avatar.obj"), "Avatar 2/avatar.obj");
});

test("DEFAULT_OBJ_ASSET_FILES is the default OBJ/MTL pair", () => {
    assert.deepEqual(DEFAULT_OBJ_ASSET_FILES, ["avatar.obj", "avatar.mtl"]);
});
