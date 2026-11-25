const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { NodeIO } = require("@gltf-transform/core");
const JSZip = require("jszip");
const { getLang, t } = require("./i18n");
const { buildFbx } = require("./fbx-exporter");
const { convertAvatar, getPartInfo } = require("./auto-rig");
const { createConversionLimiter } = require("./conversion-limiter");
const { createAdmissionLimiter } = require("./admission-limiter");
const { parseNonNegativeNumber, parsePositiveNumber } = require("./config");
const { isUserLocked, tryWithUserLock, withUserLock } = require("./user-lock");
const { ConversionPool } = require("./worker/conversion-pool");
const profile = require("./profiler");

const SUPPORTED_FORMATS = ["glb", "gltf", "fbx"];

// Conversion deadline (env CONVERSION_DEADLINE_MS, default 110s — below the 120s
// request timeout). On expiry the in-flight worker is terminated and respawned.
const conversionDeadlineMs = parsePositiveNumber(process.env.CONVERSION_DEADLINE_MS, 110_000);

// Cap simultaneous conversions so a burst cannot exhaust memory/CPU. Requests
// beyond the queue limit get a retryable 503 instead of piling up.
const defaultConversionLimiter = createConversionLimiter({
    maxConcurrent: parsePositiveNumber(process.env.MAX_CONCURRENT_CONVERSIONS, 2),
    maxQueue: parseNonNegativeNumber(process.env.MAX_CONVERSION_QUEUE, 8)
});

// The explorer route parses/segments an OBJ on the event loop. It needs its
// own admission control so it cannot bypass the conversion queue.
const defaultPartsLimiter = createAdmissionLimiter({
    maxConcurrent: parsePositiveNumber(process.env.MAX_CONCURRENT_PARTS, 2),
    maxQueue: parseNonNegativeNumber(process.env.MAX_PARTS_QUEUE, 8),
    code: "EPARTSBUSY",
    message: "Part analysis queue is full"
});


/**
 * Parse a boolean query param that may be "1", "true", "yes", etc.
 */
function parseBool(value) {
    if (value === undefined || value === null) return false;
    const v = String(value).toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Sanitize the avatar display name used as the root object/collection name.
 */
function sanitizeGroupName(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    const cleaned = raw
        .replace(/[^\w \-.]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 64);

    return cleaned || "Avatar";
}

/**
 * Write a glTF document to a temporary directory as separate files
 * (.gltf + .bin + textures). Returns the list of file paths.
 */
async function writeGltfSeparate(doc, outDir) {
    const io = new NodeIO();
    // NodeIO writes external .bin + textures when the target is a .gltf path
    // and resources have URIs. Force external URIs first.
    const buffers = doc.getRoot().listBuffers();
    buffers.forEach((buf, i) => {
        if (!buf.getURI()) buf.setURI(i === 0 ? "model.bin" : `buffer${i}.bin`);
    });
    const textures = doc.getRoot().listTextures();
    textures.forEach((tex, i) => {
        if (!tex.getURI()) tex.setURI(`texture${i}.png`);
    });

    const gltfPath = path.join(outDir, "model.gltf");
    await io.write(gltfPath, doc);

    const files = [];
    const entries = await fs.readdir(outDir);
    for (const entry of entries) {
        files.push({ name: entry, path: path.join(outDir, entry) });
    }
    return files;
}

/**
 * Write a glTF document as a single embedded .gltf (data URIs for buffer + images).
 * Returns the JSON string.
 */
async function writeGltfEmbedded(doc) {
    const io = new NodeIO();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aae-embed-"));
    try {
        const buffers = doc.getRoot().listBuffers();
        buffers.forEach((buf, i) => {
            if (!buf.getURI()) buf.setURI(i === 0 ? "model.bin" : `buffer${i}.bin`);
        });
        const textures = doc.getRoot().listTextures();
        textures.forEach((tex, i) => {
            if (!tex.getURI()) tex.setURI(`texture${i}.png`);
        });

        const gltfPath = path.join(tmpDir, "model.gltf");
        await io.write(gltfPath, doc);

        const json = JSON.parse(await fs.readFile(gltfPath, "utf8"));

        if (json.buffers) {
            for (const buf of json.buffers) {
                if (buf.uri && !buf.uri.startsWith("data:")) {
                    const data = await fs.readFile(path.join(tmpDir, buf.uri));
                    const mime = buf.uri.endsWith(".bin") ? "application/octet-stream" : "application/octet-stream";
                    buf.uri = `data:${mime};base64,${data.toString("base64")}`;
                }
            }
        }

        if (json.images) {
            for (const img of json.images) {
                if (img.uri && !img.uri.startsWith("data:")) {
                    const data = await fs.readFile(path.join(tmpDir, img.uri));
                    const ext = path.extname(img.uri).toLowerCase();
                    const mime = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
                    img.uri = `data:${mime};base64,${data.toString("base64")}`;
                }
            }
        }

        return JSON.stringify(json);
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

function streamZip(res, zip, filename) {
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
    );

    return new Promise((resolve, reject) => {
        const stream = zip.generateNodeStream({
            type: "nodebuffer",
            streamFiles: true
        });
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            if (error) {
                if (!res.headersSent) {
                    reject(error);
                } else {
                    res.destroy(error);
                    resolve();
                }
            } else {
                resolve();
            }
        };

        stream.on("error", finish);
        res.on("finish", () => finish());
        res.on("close", () => {
            if (!res.writableEnded) {
                stream.destroy();
            }
            finish();
        });
        stream.pipe(res);
    });
}

function sendGeneratedFile(res, filePath, filename, contentType) {
    res.setHeader("Content-Type", contentType);
    res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
    );

    return new Promise((resolve, reject) => {
        res.sendFile(filePath, (error) => {
            fs.unlink(filePath).catch(() => {});
            if (error) {
                if (!res.headersSent) {
                    reject(error);
                } else {
                    resolve();
                }
            } else {
                resolve();
            }
        });
    });
}

/**
 * Map a conversion/export failure to its client-visible outcome: oversized
 * exports are a 413, a requested-rig failure is a 422, and any other failure is
 * rethrown for the outer handler to answer with a 500.
 */
function handleExportError(res, lang, error, { rig, logLabel }) {
    const errorId = crypto.randomUUID();
    console.error(`${logLabel} [${errorId}]:`, error);

    if (error && error.code === "EOBJTOOLARGE") {
        return res.status(413).json({
            success: false,
            message: t(lang, "convert.too_large")
        });
    }

    // A rig failure is a client-visible 422; other failures
    // (I/O, parser, memory) remain a 500.
    if (!rig) {
        throw error;
    }

    return res.status(422).json({
        success: false,
        message: t(lang, "convert.rig_failed_generic")
    });
}

// Reusable conversion worker pool (size = MAX_CONCURRENT_CONVERSIONS). Created
// lazily once and shared across route registrations. Tests can inject a pool via
// options.pool.
let defaultPool = null;
function getPool(options = {}) {
    if (options.pool) {
        return options.pool;
    }
    if (!defaultPool) {
        defaultPool = new ConversionPool({
            size: parsePositiveNumber(process.env.MAX_CONCURRENT_CONVERSIONS, 2),
            recycleAfter: parsePositiveNumber(process.env.MAX_WORKER_RECYCLE_JOBS, 50),
            resourceLimits: {
                maxOldGenerationSizeMb: parsePositiveNumber(process.env.MAX_WORKER_HEAP_MB, 512)
            }
        });
    }
    return defaultPool;
}

// Send a worker conversion result using the same response shapes as before.
async function sendConversionResult(res, result, userId, assetDir, separate) {
    if (result.kind === "glb") {
        res.setHeader("Content-Type", "model/gltf-binary");
        res.setHeader("Content-Disposition", `attachment; filename="${userId}.glb"`);
        return res.send(Buffer.from(result.data));
    }

    if (result.kind === "gltf") {
        res.setHeader("Content-Type", "model/gltf+json");
        res.setHeader("Content-Disposition", `attachment; filename="${userId}.gltf"`);
        return res.send(result.text);
    }

    if (result.kind === "gltf-separate") {
        const zip = new JSZip();
        for (const file of result.files) {
            const zipName = file.name === "model.gltf" ? `${userId}.gltf` : file.name;
            zip.file(zipName, Buffer.from(file.data));
        }
        return streamZip(res, zip, `${userId}.zip`);
    }

    // fbx
    const fbx = Buffer.from(result.data);
    if (separate) {
        const zip = new JSZip();
        zip.file(`${userId}.fbx`, fbx);
        const entries = await fs.readdir(assetDir);
        for (const entry of entries) {
            if (!/^texture\d+\.png$/i.test(entry)) {
                continue;
            }
            zip.file(entry, await fs.readFile(path.join(assetDir, entry)));
        }
        return streamZip(res, zip, `${userId}.zip`);
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${userId}.fbx"`);
    return res.send(fbx);
}

module.exports = function (app, options = {}) {
    const partsLimiter = options.partsLimiter || defaultPartsLimiter;
    const conversionLimiter = options.conversionLimiter || defaultConversionLimiter;
    const pool = getPool(options);
    const deadlineMs = options.conversionDeadlineMs || conversionDeadlineMs;

    // Lightweight part-mapping lookup for the model explorer sidebar.
    app.get("/api/roblox/parts/:userId", async (req, res) => {
        const lang = getLang(req);
        const { userId } = req.params;

        if (!/^\d+$/.test(userId)) {
            return res.status(400).json({
                success: false,
                message: t(lang, "convert.invalid_user_id")
            });
        }

        const assetDir = path.join(__dirname, "../downloads", userId);

        try {
            await fs.access(path.join(assetDir, "avatar.obj"));
        } catch {
            return res.status(404).json({
                success: false,
                message: t(lang, "convert.no_obj")
            });
        }

        // Fail fast when this user's cache is already locked (a download or
        // conversion is in progress): return 503 without taking a parts slot or
        // waiting. Holding a slot while blocked on the per-user lock is what let
        // one user's long download starve other users' parts requests.
        const busyResponse = () => {
            res.set("Retry-After", "5");
            return res.status(503).json({
                success: false,
                message: t(lang, "parts.busy")
            });
        };

        if (isUserLocked(userId)) {
            return busyResponse();
        }

        let release;
        try {
            release = await partsLimiter.acquire();
        } catch (error) {
            if (error && error.code === "EPARTSBUSY") {
                return busyResponse();
            }
            throw error;
        }

        try {
            const moreJoints = parseBool(req.query.moreJoints);
            // Serialize with downloads/conversions for the same user so the
            // explorer cannot read avatar.json/avatar.obj across a cache swap.
            // tryWithUserLock is non-blocking: if a same-user download/conversion
            // grabbed the lock while we waited for a slot, fail fast instead of
            // blocking while holding the slot. getPartInfo does not take the
            // lock itself, so there is no re-entry/deadlock.
            const attempt = tryWithUserLock(userId, () =>
                getPartInfo(assetDir, { moreJoints })
            );

            if (attempt.locked) {
                return busyResponse();
            }

            const info = await attempt.promise;
            res.json({
                success: true,
                rigType: info.rigType,
                robloxType: info.robloxType,
                compatibility: info.compatibility,
                groups: info.groups,
                bones: info.bones,
                segmentation: info.segmentation
            });
        } catch (err) {
            console.error("Part info error:", err);
            if (!res.headersSent) {
                const tooLarge = err && err.code === "EOBJTOOLARGE";
                res.status(tooLarge ? 413 : 500).json({
                    success: false,
                    message: t(lang, tooLarge ? "convert.too_large" : "convert.failed")
                });
            }
        } finally {
            release();
        }
    });

    // Conversion has side effects (temporary files) and is expensive; never
    // run it for a HEAD probe.
    app.head("/api/roblox/convert/:userId/:format", (req, res) => {
        res.set("Allow", "GET").status(405).end();
    });

    app.get("/api/roblox/convert/:userId/:format", async (req, res) => {
        const lang = getLang(req);
        const { userId } = req.params;
        const fmt = (req.params.format || "").toLowerCase();

        if (!/^\d+$/.test(userId)) {
            return res.status(400).json({
                success: false,
                message: t(lang, "convert.invalid_user_id")
            });
        }

        if (!SUPPORTED_FORMATS.includes(fmt)) {
            return res.status(400).json({
                success: false,
                message: t(lang, "convert.unsupported")
            });
        }

        const rig = parseBool(req.query.rig);
        // Every export keeps body parts as separate objects. "Separate assets"
        // only chooses packaging for GLTF/FBX: one self-contained file vs ZIP
        // with external assets. GLB is always one embedded binary; OBJ is
        // already split and generated client-side. `compat` is kept as an
        // alias for older frontends.
        const separate =
            fmt !== "glb" &&
            (parseBool(req.query.separate) || parseBool(req.query.compat));
        const splitParts = true;
        const groupName = sanitizeGroupName(req.query.name);
        const subdivision = Math.max(
            0,
            Math.min(4, Number.parseInt(req.query.subdivision, 10) || 0)
        );
        const moreJoints = parseBool(req.query.moreJoints);
        // "Bend accessories" (default off) skins multi-part R15 clothing so it
        // deforms with the body; off keeps every accessory rigid.
        const bendAccessories =
            req.query.bendAccessories === undefined
                ? false
                : parseBool(req.query.bendAccessories);

        const assetDir = path.join(__dirname, "../downloads", userId);
        const objPath = path.join(assetDir, "avatar.obj");

        let release;

        try {
            release = await profile.run("admission", () => conversionLimiter.acquire());
        } catch (error) {
            if (error && error.code === "ECONVERSIONBUSY") {
                res.set("Retry-After", "5");
                return res.status(503).json({
                    success: false,
                    message: t(lang, "convert.busy")
                });
            }

            throw error;
        }

        try {
            // Share the per-user lock with downloads so a cache swap cannot
            // happen while conversion is reading avatar.obj/mtl/textures.
            const userLockTask = withUserLock(userId, async () => {
            try {
                await fs.access(objPath);
            } catch {
                return res.status(404).json({
                    success: false,
                    message: t(lang, "convert.no_obj")
                });
            }

        // Declared here (outside the try) so the catch can read why the run
        // aborted (deadline vs client disconnect).
        let deadlineExceeded = false;

        try {
            // Keep the head out of the mesh-quality subdivision for FBX (matches
            // the GLB/GLTF behaviour).
            let excludeSubdivision = [];
            if (fmt === "fbx" && subdivision > 0) {
                try {
                    const info = getPartInfo(assetDir);
                    excludeSubdivision = info.groups
                        .filter(
                            (g) =>
                                !/^handle/i.test(g.name) &&
                                (g.part === "Head" || /^head$/i.test(g.name))
                        )
                        .map((g) => g.name);
                } catch {
                    excludeSubdivision = [];
                }
            }

            const job = {
                fmt,
                assetDir,
                separate,
                options: {
                    rig,
                    splitParts,
                    groupName,
                    subdivision,
                    moreJoints,
                    bendAccessories,
                    embedTextures: !separate,
                    excludeSubdivision
                }
            };

            // Cancellation: abort on client disconnect (before the response
            // finishes) or when the conversion deadline fires. The pool
            // terminates that worker, respawns it, and rejects the run; the
            // limiter slot is released exactly once in the outer finally.
            const ac = new AbortController();
            const deadline = setTimeout(() => {
                deadlineExceeded = true;
                ac.abort();
            }, deadlineMs);
            if (typeof deadline.unref === "function") deadline.unref();
            const onClose = () => {
                if (!res.writableEnded) ac.abort();
            };
            res.on("close", onClose);

            try {
                // Run the full convert + serialize in the worker pool. The
                // limiter slot is held for the whole job.
                const result = await profile.run("worker_convert", () =>
                    pool.run(job, { signal: ac.signal })
                );
                await sendConversionResult(res, result, userId, assetDir, separate);
            } finally {
                clearTimeout(deadline);
                res.off("close", onClose);
            }
        } catch (err) {
            // Cancelled (client gone or deadline): do not double-send.
            if (err && (err.name === "AbortError" || err.code === "ECONVERSIONCANCELLED")) {
                if (deadlineExceeded && !res.headersSent) {
                    res.set("Retry-After", "5");
                    return res.status(504).json({
                        success: false,
                        message: t(lang, "convert.timeout")
                    });
                }
                return;
            }

            // A worker that exceeded its V8 heap limit dies alone; surface a
            // clear, retryable 503 rather than a generic 500.
            if (err && err.workerCode === "ERR_WORKER_OUT_OF_MEMORY") {
                console.error("Conversion worker out of memory:", err);
                if (!res.headersSent) {
                    res.set("Retry-After", "5");
                    return res.status(503).json({
                        success: false,
                        message: t(lang, "convert.worker_oom")
                    });
                }
                return;
            }

            if (err && err.code === "ECONVERSIONCRASH") {
                console.error("Conversion worker crashed:", err);
                if (!res.headersSent) {
                    return res.status(500).json({
                        success: false,
                        message: t(lang, "convert.failed")
                    });
                }
                return;
            }

            return handleExportError(res, lang, err, {
                rig,
                logLabel: "Avatar conversion failed"
            });
        }
            });
            await profile.run("user_lock_wait", () => userLockTask);
        } catch (err) {
            console.error("Convert error:", err);

            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    message: t(lang, "convert.failed")
                });
            }
        } finally {
            release();

            const spans = profile.finishSpans();
            if (spans.length > 0) {
                console.log(
                    `[profile] format=${fmt} userId=${userId} stages=${JSON.stringify(
                        spans.map((span) => ({
                            stage: span.stage,
                            durationMs: span.durationMs,
                            cpuDurationMs: span.cpuDurationMs,
                            rssBytes: span.rssBytes
                        }))
                    )}`
                );
            }
        }
    });
};