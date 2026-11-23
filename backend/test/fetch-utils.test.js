"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { fetchWithTimeout, isTimeoutError } = require("../fetch-utils");

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve(`http://127.0.0.1:${server.address().port}`);
        });
    });
}

test("fetchWithTimeout returns a normal response body", async () => {
    const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
    });

    const base = await listen(server);

    try {
        const response = await fetchWithTimeout(`${base}/fast`, {}, 1000);
        assert.deepEqual(await response.json(), { ok: true });
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});

test("fetchWithTimeout aborts while the response body is still streaming", async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        // Send headers and a partial body but never finish. The old helper
        // cleared its timer after headers, so this could hang forever.
        res.write('{"partial":');
    });

    const base = await listen(server);

    try {
        const response = await fetchWithTimeout(`${base}/stall`, {}, 500);
        const started = Date.now();

        await assert.rejects(
            () => response.text(),
            (error) => error.name === "AbortError" && isTimeoutError(error)
        );

        assert.ok(Date.now() - started < 2000, "body read was aborted promptly");
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});
