"use strict";

// Lightweight backend profiler for conversion pipeline stage timing.
//
// Enabled only when the AAE_PROFILE_STAGES environment flag is truthy
// (parsed via the shared config parser; disabled by default). Uses Node
// built-ins only (process.hrtime.bigint, process.cpuUsage, process.memoryUsage)
// and adds no dependencies.

const { parseBoolean } = require("./config");

let enabled = parseBoolean(process.env.AAE_PROFILE_STAGES, false);

const activeSpans = new Map();
const finishedSpans = [];
let spanSeq = 0;

function resetProfilingState() {
    activeSpans.clear();
    finishedSpans.length = 0;
}

function configureProfiling(enabledValue) {
    enabled = parseBoolean(enabledValue, false);
    resetProfilingState();
}

function resetProfiling() {
    resetProfilingState();
}

function isProfilingEnabled() {
    return enabled;
}

function begin(name, meta = {}) {
    if (!enabled) {
        return null;
    }

    const id = `span-${++spanSeq}`;
    activeSpans.set(id, {
        name,
        meta,
        start: process.hrtime.bigint(),
        cpuStart: process.cpuUsage(),
        rssStart: process.memoryUsage().rss
    });

    return id;
}

function end(id) {
    if (!id) {
        return null;
    }

    const span = activeSpans.get(id);
    if (!span) {
        return null;
    }

    activeSpans.delete(id);

    const endCpu = process.cpuUsage();
    const durationMs = Number(process.hrtime.bigint() - span.start) / 1e6;
    // process.cpuUsage() deltas are in microseconds on this runtime; convert
    // to milliseconds for the reported cpuDurationMs field.
    const cpuDurationMs =
        (endCpu.user - span.cpuStart.user) / 1000 +
        (endCpu.system - span.cpuStart.system) / 1000;
    const rssBytes = process.memoryUsage().rss;

    const record = {
        stage: span.name,
        durationMs,
        cpuDurationMs,
        rssBytes,
        ...span.meta
    };

    finishedSpans.push(record);

    return record;
}

async function run(name, fn, meta = {}) {
    const id = enabled ? begin(name, meta) : null;

    try {
        const result = await fn();
        if (id) {
            end(id);
        }
        return result;
    } catch (error) {
        if (id) {
            end(id);
        }
        throw error;
    }
}

function finishSpans() {
    const spans = finishedSpans.splice(0);
    return spans;
}

module.exports = {
    configureProfiling,
    isProfilingEnabled,
    resetProfilingState,
    begin,
    end,
    run,
    finishSpans
};
