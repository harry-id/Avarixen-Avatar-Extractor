"use strict";

// Deterministic mock of the Roblox avatar + CDN endpoints over TLS, for the
// Docker download-protection verification. Logs to stdout and exposes a control
// HTTP server (default :8080) returning JSON counters so the host probe can read
// how many upstream sequences happened.

const https = require("https");
const http = require("http");
const fs = require("fs");

const DIR = __dirname;
const opts = {
    key: fs.readFileSync(`${DIR}/server.key`),
    cert: fs.readFileSync(`${DIR}/server.pem`)
};

const OBJ = [
    "mtllib avatar.mtl",
    "v 0 0 0", "v 2 0 0", "v 0 2 0",
    "vt 0 0", "vt 1 0", "vt 0 1",
    "vn 0 0 1",
    "usemtl cloth",
    "g Body",
    "f 1/1/1 2/2/1 3/3/1",
    ""
].join("\n");
const MTL = "newmtl cloth\nKd 0.8 0.8 0.8\nmap_Kd texhash\n";
const METADATA = JSON.stringify({ obj: "objhash", mtl: "mtlhash", textures: ["texhash"] });
// 1x1 PNG
const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
);

const counts = { avatar3d: 0, metadata: 0, obj: 0, mtl: 0, tex: 0, player: 0, other: 0 };

function send(res, status, body, type) {
    res.writeHead(status, { "content-type": type || "application/json" });
    res.end(body);
}

const server = https.createServer(opts, (req, res) => {
    const host = req.headers.host || "";
    const url = req.url || "";

    if (host.startsWith("thumbnails.roblox.com") && url.includes("avatar-3d")) {
        counts.avatar3d += 1;
        return send(res, 200, JSON.stringify({ data: [{ imageUrl: "https://tr.rbxcdn.com/metadata" }] }));
    }
    if (host.startsWith("avatar.roblox.com")) {
        counts.player += 1;
        return send(res, 404, JSON.stringify({ errors: [{ message: "not found" }] }));
    }
    if (host.startsWith("users.roblox.com")) {
        counts.other += 1;
        return send(res, 200, JSON.stringify({ id: 1, name: "Mock", displayName: "Mock" }));
    }
    if (url.endsWith("/metadata")) {
        counts.metadata += 1;
        return send(res, 200, METADATA, "application/json");
    }
    if (url.endsWith("/objhash")) { counts.obj += 1; return send(res, 200, OBJ, "text/plain"); }
    if (url.endsWith("/mtlhash")) { counts.mtl += 1; return send(res, 200, MTL, "text/plain"); }
    if (url.endsWith("/texhash")) { counts.tex += 1; return send(res, 200, PNG, "image/png"); }

    counts.other += 1;
    return send(res, 404, JSON.stringify({ error: "unknown", host, url }));
});

// Control server (plain HTTP) for counters + reset.
const control = http.createServer((req, res) => {
    if (req.url === "/reset") {
        for (const k of Object.keys(counts)) counts[k] = 0;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(counts));
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(counts));
});

server.listen(443, "0.0.0.0", () => console.log("mock https on 443"));
control.listen(8080, "0.0.0.0", () => console.log("mock control on 8080"));