"use strict";

// Per-user serialization for cache operations.
//
// Download, conversion, and explorer reads for the same Roblox user ID must
// not overlap: a download replaces multiple files that a conversion is
// reading, and two simultaneous downloads used to interleave writes. Keying
// the queue by user ID keeps unrelated users fully concurrent while making
// same-user operations deterministic.

const queues = new Map();

function withUserLock(key, task) {
    const name = String(key);
    let state = queues.get(name);

    if (!state) {
        state = { tail: Promise.resolve(), count: 0 };
        queues.set(name, state);
    }

    state.count += 1;

    // A failed task must not poison the queue for the next waiters.
    const run = state.tail.catch(() => {}).then(task);
    state.tail = run.catch(() => {});

    return run.finally(() => {
        state.count -= 1;

        if (state.count === 0 && queues.get(name) === state) {
            queues.delete(name);
        }
    });
}

function isUserLocked(key) {
    return queues.has(String(key));
}

/**
 * Non-blocking variant of withUserLock.
 *
 * If `key` is already locked, returns `{ locked: true }` without enqueuing, so
 * callers can fail fast instead of waiting (and, in the parts route, without
 * holding a global limiter slot while blocked). Otherwise runs `task` under the
 * lock and returns `{ locked: false, promise }`.
 *
 * The check and the (synchronous) enqueue inside withUserLock happen in the
 * same tick, so there is no await between them: a caller that sees
 * `locked: false` will not then block on the lock.
 */
function tryWithUserLock(key, task) {
    const name = String(key);

    if (queues.has(name)) {
        return { locked: true };
    }

    return { locked: false, promise: withUserLock(name, task) };
}

module.exports = {
    isUserLocked,
    tryWithUserLock,
    withUserLock
};
