import { test } from "node:test";
import assert from "node:assert/strict";

import { buildConversionParams } from "../convert-params.mjs";

test("default parameters produce an empty query string", () => {
    assert.equal(buildConversionParams().toString(), "");
});

test("rig enables the rig parameter", () => {
    const params = buildConversionParams({ rig: true });

    assert.equal(params.get("rig"), "1");
});

test("separate enables separate assets", () => {
    const params = buildConversionParams({ separate: true });

    assert.equal(params.get("separate"), "1");
});

test("subdivision is only sent when above zero", () => {
    assert.equal(buildConversionParams({ subdivision: 0 }).toString(), "");
    assert.equal(buildConversionParams({ subdivision: 2 }).get("subdivision"), "2");
});

test("moreJoints enables the moreJoints parameter", () => {
    assert.equal(buildConversionParams({ moreJoints: true }).get("moreJoints"), "1");
    assert.equal(buildConversionParams({ moreJoints: false }).get("moreJoints"), null);
});

test("bendAccessories is sent only when the rig is enabled, as 0 or 1", () => {
    assert.equal(buildConversionParams({ rig: true, bendAccessories: true }).get("bendAccessories"), "1");
    assert.equal(buildConversionParams({ rig: true, bendAccessories: false }).get("bendAccessories"), "0");
    assert.equal(buildConversionParams({ rig: false, bendAccessories: true }).get("bendAccessories"), null);
});

test("name is only sent when provided", () => {
    assert.equal(buildConversionParams({ name: "RobloxName" }).get("name"), "RobloxName");
    assert.equal(buildConversionParams({ name: null }).get("name"), null);
});
