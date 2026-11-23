import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 4598;
const BASE = `http://127.0.0.1:${PORT}`;

const FRONTEND_MODULES = [
    {
        url: "/status.mjs",
        expects: ["export function isStatusBusyKey", "export function isStatusErrorKey"]
    },
    {
        url: "/format-support.mjs",
        expects: ["export const FORMAT_OPTION_SUPPORT", "export function isFormatOptionSupported"]
    },
    {
        url: "/naming.mjs",
        expects: [
            "export const DEFAULT_OBJ_ASSET_FILES",
            "export function resolveAssetFiles",
            "export function sanitizeExportName",
            "export function objMtlFileNames",
            "export function zipEntryName"
        ]
    },
    {
        url: "/convert-params.mjs",
        expects: ["export function buildConversionParams"]
    }
];

function startFrontendServer() {
    const child = spawn(process.execPath, ["server.js"], {
        cwd: FRONTEND_DIR,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ["ignore", "ignore", "ignore"]
    });

    return child;
}

async function waitForServer(url, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;

    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.status) {
                return res;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`frontend server did not become ready: ${lastError}`);
}

test("frontend serving exposes the extracted frontend modules and keeps the UI routes intact", async () => {
    const child = startFrontendServer();
    const rootRes = await waitForServer(`${BASE}/`);

    try {
        for (const mod of FRONTEND_MODULES) {
            const moduleRes = await waitForServer(`${BASE}${mod.url}`);

            assert.equal(moduleRes.status, 200, `expected module ${mod.url} to be served`);
            assert.match(moduleRes.headers.get("content-type") || "", /javascript/);

            const body = await moduleRes.text();

            for (const expected of mod.expects) {
                assert.match(body, new RegExp(expected), `expected module ${mod.url} to contain ${expected}`);
            }
        }

        assert.equal(rootRes.status, 200);

        const forbidden = await fetch(`${BASE}/server.js`);
        assert.equal(forbidden.status, 404);

        const forbiddenPackage = await fetch(`${BASE}/package.json`);
        assert.equal(forbiddenPackage.status, 404);

        const assets = await fetch(`${BASE}/assets/12345/avatar.obj`);
        assert.equal(assets.status, 404);
    } finally {
        await new Promise((resolve, reject) => {
            child.once("exit", (code) => resolve(code));
            child.kill("SIGTERM");
        });
    }
});
