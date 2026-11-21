"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { isUserLocked, withUserLock } = require("../user-lock");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("withUserLock serializes work for the same user", async () => {
    const order = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

    const first = withUserLock("42", async () => {
        order.push("first:start");
        await firstGate;
        order.push("first:end");
    });

    const second = withUserLock("42", async () => {
        order.push("second");
    });

    await delay(10);
    assert.deepEqual(order, ["first:start"]);
    assert.equal(isUserLocked("42"), true);

    releaseFirst();
    await Promise.all([first, second]);

    assert.deepEqual(order, ["first:start", "first:end", "second"]);
    assert.equal(isUserLocked("42"), false);
});

test("withUserLock allows different users to run concurrently", async () => {
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const a = withUserLock("a", async () => {
        order.push("a:start");
        await gate;
        order.push("a:end");
    });

    const b = withUserLock("b", async () => {
        order.push("b:done");
    });

    await delay(10);
    assert.deepEqual(order, ["a:start", "b:done"]);

    release();
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a:start", "b:done", "a:end"]);
});

test("a rejected task does not block the next waiter", async () => {
    await assert.rejects(
        withUserLock("7", async () => {
            throw new Error("boom");
        }),
        /boom/
    );

    const value = await withUserLock("7", async () => "next");
    assert.equal(value, "next");
});
