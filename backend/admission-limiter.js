"use strict";

class AdmissionBusyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "AdmissionBusyError";
        this.code = code;
    }
}

/**
 * Bounded semaphore + FIFO queue used by download and part-analysis endpoints.
 * Callers must invoke the returned release function in a finally block.
 */
function createAdmissionLimiter({
    maxConcurrent = 1,
    maxQueue = 0,
    code = "EADMISSIONBUSY",
    message = "Admission queue is full"
} = {}) {
    const concurrency = Math.max(1, Math.floor(maxConcurrent) || 1);
    const queueLimit = Math.max(0, Math.floor(maxQueue) || 0);
    const busyCode = code;
    const busyMessage = message;

    let active = 0;
    const queue = [];

    function grant(increment = true) {
        if (increment) active += 1;
        let released = false;

        return () => {
            if (released) return;
            released = true;

            const next = queue.shift();
            if (next) {
                next.resolve();
            } else {
                active -= 1;
            }
        };
    }

    function acquire() {
        if (active < concurrency) {
            return Promise.resolve(grant());
        }

        if (queue.length >= queueLimit) {
            return Promise.reject(new AdmissionBusyError(busyCode, busyMessage));
        }

        return new Promise((resolve) => {
            queue.push({ resolve });
        }).then(() => grant(false));
    }

    return {
        acquire,
        get active() {
            return active;
        },
        get queued() {
            return queue.length;
        },
        get maxConcurrent() {
            return concurrency;
        }
    };
}

module.exports = {
    AdmissionBusyError,
    createAdmissionLimiter
};
