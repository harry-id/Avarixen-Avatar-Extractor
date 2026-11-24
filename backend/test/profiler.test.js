"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    configureProfiling,
    isProfilingEnabled,
    begin,
    end,
    run,
    finishSpans
} = require("../profiler");

test("profiling is disabled by default and records no spans", async () => {
    configureProfiling(false);

    assert.equal(isProfilingEnabled(), false);

    const result = await run("default_disabled_stage", () => 42);

    assert.equal(result, 42);
    assert.deepEqual(finishSpans(), []);
});

test("run records stage durations when profiling is enabled", async () => {
    configureProfiling(true);

    const result = await run("stage_probe", () => 7);

    assert.equal(result, 7);

    const spans = finishSpans();

    assert.equal(spans.length, 1);
    assert.equal(spans[0].stage, "stage_probe");
    assert.equal(typeof spans[0].durationMs, "number");
    assert.ok(spans[0].durationMs >= 0);
    assert.equal(typeof spans[0].cpuDurationMs, "number");
    assert.ok(spans[0].cpuDurationMs >= 0);
    assert.equal(typeof spans[0].rssBytes, "number");

    configureProfiling(false);
});

test("run closes the stage and propagates errors", async () => {
    configureProfiling(true);

    await assert.rejects(
        () => run("stage_probe_error", () => Promise.reject(new Error("boom"))),
        /boom/
    );

    const spans = finishSpans();

    assert.equal(spans.length, 1);
    assert.equal(spans[0].stage, "stage_probe_error");

    configureProfiling(false);
});

test("begin and end track manual spans when profiling is enabled", () => {
    configureProfiling(true);

    const id = begin("manual_stage", { format: "glb" });
    assert.ok(id);

    const record = end(id);

    assert.ok(record);
    assert.equal(record.stage, "manual_stage");
    assert.equal(record.format, "glb");

    configureProfiling(false);
});

test("begin and end are no-ops when profiling is disabled", () => {
    configureProfiling(false);

    assert.equal(begin("manual_stage"), null);
    assert.equal(end(null), null);
    assert.deepEqual(finishSpans(), []);
});
