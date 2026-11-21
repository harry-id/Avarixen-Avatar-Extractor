"use strict";

// fetch() helpers for upstream Roblox/CDN requests.
//
// The important detail is that a timeout must cover the response *body* too.
// A plain `fetch()` promise resolves as soon as headers arrive, so clearing a
// timer at that point leaves `response.json()` / `response.arrayBuffer()`
// able to hang forever on a stalled connection. These helpers keep the abort
// signal alive for the lifetime of the response and translate timeout errors
// (including the body-read `TimeoutError` from AbortSignal.timeout) into the
// `AbortError` shape the route handlers already map to HTTP 504.

function normalizeTimeoutError(error, timeoutMs) {
    if (
        error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
        const timeoutError = new Error(`Request timed out after ${timeoutMs}ms`);
        timeoutError.name = "AbortError";
        timeoutError.code = "ETIMEDOUT";
        timeoutError.cause = error;
        return timeoutError;
    }

    return error;
}

function createTimeoutSignal(timeoutMs) {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(timeoutMs);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Never keep the process alive just to fire a request timeout.
    if (timer && typeof timer.unref === "function") {
        timer.unref();
    }

    return controller.signal;
}

function combineSignals(signals) {
    const available = signals.filter(Boolean);

    if (available.length === 0) {
        return undefined;
    }

    if (available.length === 1) {
        return available[0];
    }

    if (typeof AbortSignal.any === "function") {
        return AbortSignal.any(available);
    }

    // Older Node versions: the request timeout is the important signal here.
    return available[available.length - 1];
}

// Wrap the body-consuming methods so a timeout while reading the body is
// reported with the same AbortError name as a header timeout.
function wrapResponse(response, timeoutMs) {
    const bodyMethods = new Set(["arrayBuffer", "blob", "formData", "json", "text"]);

    return new Proxy(response, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, target);

            if (bodyMethods.has(property) && typeof value === "function") {
                return async (...args) => {
                    try {
                        return await value.apply(target, args);
                    } catch (error) {
                        throw normalizeTimeoutError(error, timeoutMs);
                    }
                };
            }

            return value;
        }
    });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const { signal: callerSignal, ...init } = options;
    const timeoutSignal = createTimeoutSignal(timeoutMs);
    const signal = combineSignals([callerSignal, timeoutSignal]);

    let response;

    try {
        response = await fetch(url, { ...init, signal });
    } catch (error) {
        throw normalizeTimeoutError(error, timeoutMs);
    }

    return wrapResponse(response, timeoutMs);
}

function isTimeoutError(error) {
    return Boolean(
        error &&
        (error.name === "AbortError" ||
            error.name === "TimeoutError" ||
            error.code === "ETIMEDOUT")
    );
}

module.exports = {
    fetchWithTimeout,
    isTimeoutError,
    normalizeTimeoutError
};
