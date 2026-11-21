"use strict";

// Bounded concurrency for CPU/memory-heavy conversions.
//
// GLB/GLTF/FBX generation parses and rebuilds the whole avatar in the Node
// process. Without a limit, a burst of requests can exhaust memory and make
// every request (including health checks) slow. This is intentionally a small
// semaphore + bounded queue rather than a worker pool: it caps the damage
// without changing the API or adding infrastructure. A worker pool can be
// layered on later behind the same acquire()/release() contract.

class ConversionBusyError extends Error {
    constructor(message = "Conversion queue is full") {
        super(message);
        this.name = "ConversionBusyError";
        this.code = "ECONVERSIONBUSY";
    }
}

function createConversionLimiter({ maxConcurrent = 2, maxQueue = 8 } = {}) {
    const concurrency = Math.max(1, Math.floor(maxConcurrent) || 1);
    const queueLimit = Math.max(0, Math.floor(maxQueue) || 0);

    let active = 0;
    const queue = [];

    function grant(increment = true) {
        if (increment) {
            active += 1;
        }
        let released = false;

        return () => {
            if (released) {
                return;
            }
            released = true;

            const next = queue.shift();

            if (next) {
                // Hand the slot directly to the next waiter; `active` stays
                // the same because the slot never became free.
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
            return Promise.reject(new ConversionBusyError());
        }

        return new Promise((resolve, reject) => {
            queue.push({ resolve, reject });
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
    ConversionBusyError,
    createConversionLimiter
};
