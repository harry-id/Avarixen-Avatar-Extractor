"use strict";

// Development preset: friendlier defaults for local work.
//
// The preset applies ONLY when NODE_ENV === "development" exactly. Unset,
// "test", "production", or any other value means no preset (behavior identical
// to today). Explicit environment variables always win over the preset.
//
// It deliberately does NOT touch security/limits: the SSRF allowlist, OBJ and
// body limits, MAX_OUTPUT_FACES*, worker heap/recycle limits, conversion and
// parts queues, and DOWNLOADS_CACHE_FIRST_MS (stays an explicit opt-in).

const PRESET_DEFAULTS = {
    // Disable the cache age sweep (0 = disabled).
    DOWNLOADS_TTL_HOURS: "0",
    // Unlimited cache (0 = no byte quota).
    DOWNLOADS_MAX_BYTES: "0",
    // Verbose logging for local debugging.
    AAE_LOG_LEVEL: "debug",
    LOG_REQUESTS: "verbose",
    LOG_ASSETS: "1",
    // Effectively unlimited rate limits (defaults are 60 and 10 per minute).
    RATE_LIMIT_MAX: "100000",
    DOWNLOAD_RATE_LIMIT_MAX: "100000",
    // Enable the stage profiler (AAE_PROFILE_STAGES is the switch).
    AAE_PROFILE_STAGES: "true"
};

function isUnset(env, key) {
    return env[key] === undefined || env[key] === null || env[key] === "";
}

/** True when a HOST value is loopback (or unset, which defaults to loopback). */
function isLoopbackHost(host) {
    const value = String(host === undefined || host === null ? "" : host)
        .trim()
        .toLowerCase();
    return (
        value === "" ||
        value === "localhost" ||
        value === "::1" ||
        value.startsWith("127.")
    );
}

/**
 * Compute the preset plan for an env object without mutating it.
 * Returns { active, set: {KEY: value}, skipped: [KEY, ...] }.
 */
function computeDevPreset(env) {
    const active = Boolean(env) && env.NODE_ENV === "development";
    const set = {};
    const skipped = [];

    if (!active) {
        return { active: false, set, skipped };
    }

    for (const [key, value] of Object.entries(PRESET_DEFAULTS)) {
        if (isUnset(env, key)) {
            set[key] = value;
        } else {
            skipped.push(key);
        }
    }

    return { active: true, set, skipped };
}

/**
 * Apply the preset to `env` (mutates it) for unset keys only. Returns the plan.
 */
function applyDevPreset(env) {
    const plan = computeDevPreset(env);

    if (plan.active) {
        for (const [key, value] of Object.entries(plan.set)) {
            env[key] = value;
        }
    }

    return plan;
}

module.exports = {
    PRESET_DEFAULTS,
    computeDevPreset,
    applyDevPreset,
    isLoopbackHost
};