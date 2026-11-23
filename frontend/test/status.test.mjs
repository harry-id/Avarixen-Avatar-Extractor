import { test } from "node:test";
import assert from "node:assert/strict";

import { isStatusBusyKey, isStatusErrorKey } from "../status.mjs";

const BUSY_KEYS = [
    "statusLoadingMaterial",
    "statusLoadingModel",
    "statusSearching",
    "statusFetchMetadata",
    "statusDownloadAssets",
    "statusConverting",
    "statusRigging"
];

const ERROR_KEYS = [
    "statusLoadObjFailed",
    "statusLoadMtlFailed",
    "statusNoLocalModel",
    "errorEmptyUsername",
    "errorNotFound",
    "errorFetchMetadata",
    "errorDownloadAssets",
    "errorOccurred",
    "errorConvertFailed",
    "errorZipFetch",
    "apiOffline"
];

test("classifies every known busy key as busy", () => {
    for (const key of BUSY_KEYS) {
        assert.equal(isStatusBusyKey(key), true, `expected busy key: ${key}`);
    }
});

test("does not classify known error keys as busy", () => {
    for (const key of ERROR_KEYS) {
        assert.equal(isStatusBusyKey(key), false, `expected not busy key: ${key}`);
    }
});

test("classifies every known error key as error", () => {
    for (const key of ERROR_KEYS) {
        assert.equal(isStatusErrorKey(key), true, `expected error key: ${key}`);
    }
});

test("does not classify known busy keys as errors", () => {
    for (const key of BUSY_KEYS) {
        assert.equal(isStatusErrorKey(key), false, `expected not error key: ${key}`);
    }
});

test("unknown keys are neither busy nor error", () => {
    assert.equal(isStatusBusyKey("statusUnknown"), false);
    assert.equal(isStatusErrorKey("statusUnknown"), false);
});

test("empty string is neither busy nor error", () => {
    assert.equal(isStatusBusyKey(""), false);
    assert.equal(isStatusErrorKey(""), false);
});

test("non-string inputs are neither busy nor error", () => {
    assert.equal(isStatusBusyKey(null), false);
    assert.equal(isStatusBusyKey(undefined), false);
    assert.equal(isStatusErrorKey(123), false);
});
