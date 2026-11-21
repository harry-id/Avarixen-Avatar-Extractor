"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    ConversionBusyError,
    createConversionLimiter
} = require("../conversion-limiter");

test("conversion limiter queues up to the limit and rejects overflow", async () => {
    const limiter = createConversionLimiter({ maxConcurrent: 1, maxQueue: 1 });

    const releaseFirst = await limiter.acquire();
    assert.equal(limiter.active, 1);

    const queued = limiter.acquire();
    assert.equal(limiter.queued, 1);

    await assert.rejects(
        () => limiter.acquire(),
        (error) => error instanceof ConversionBusyError &&
            error.code === "ECONVERSIONBUSY"
    );

    releaseFirst();
    const releaseSecond = await queued;
    assert.equal(limiter.active, 1);

    releaseSecond();
    assert.equal(limiter.active, 0);
});

test("conversion limiter grants multiple slots up to maxConcurrent", async () => {
    const limiter = createConversionLimiter({ maxConcurrent: 2, maxQueue: 0 });

    const releaseA = await limiter.acquire();
    const releaseB = await limiter.acquire();
    assert.equal(limiter.active, 2);

    await assert.rejects(
        () => limiter.acquire(),
        (error) => error.code === "ECONVERSIONBUSY"
    );

    releaseA();
    releaseB();
    assert.equal(limiter.active, 0);
});

test("release is idempotent", async () => {
    const limiter = createConversionLimiter({ maxConcurrent: 1, maxQueue: 0 });
    const release = await limiter.acquire();

    release();
    release();

    assert.equal(limiter.active, 0);
    await limiter.acquire();
});
