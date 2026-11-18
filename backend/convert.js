const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { NodeIO } = require("@gltf-transform/core");
const JSZip = require("jszip");
const { getLang, t } = require("./i18n");
const { buildFbx } = require("./fbx-exporter");
const { convertAvatar, getPartInfo } = require("./auto-rig");

const SUPPORTED_FORMATS = ["glb", "gltf", "fbx"];

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

        // Replace buffer URIs with data URIs
        if (json.buffers) {
            for (const buf of json.buffers) {
                if (buf.uri && !buf.uri.startsWith("data:")) {
                    const data = await fs.readFile(path.join(tmpDir, buf.uri));
                    const mime = buf.uri.endsWith(".bin") ? "application/octet-stream" : "application/octet-stream";
                    buf.uri = `data:${mime};base64,${data.toString("base64")}`;
                }
            }
        }

        // Replace image URIs with data URIs
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

        return JSON.stringify(json, null, 2);
    } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
}

module.exports = function (app) {
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

        try {
            const info = getPartInfo(assetDir);
            res.json({
                success: true,
                rigType: info.rigType,
                groups: info.groups
            });
        } catch (err) {
            console.error("Part info error:", err);
            res.status(500).json({
                success: false,
                message: t(lang, "convert.failed")
            });
        }
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
            Math.min(3, Number.parseInt(req.query.subdivision, 10) || 0)
        );
        const moreJoints = parseBool(req.query.moreJoints);

        const assetDir = path.join(__dirname, "../downloads", userId);
        const objPath = path.join(assetDir, "avatar.obj");

        try {
            await fs.access(objPath);
        } catch {
            return res.status(404).json({
                success: false,
                message: t(lang, "convert.no_obj")
            });
        }

        try {
            if (fmt === "fbx") {
                const [objText, mtlText] = await Promise.all([
                    fs.readFile(objPath, "utf8"),
                    fs.readFile(path.join(assetDir, "avatar.mtl"), "utf8").catch(() => "")
                ]);

                // Keep the head out of the mesh-quality subdivision (matches
                // the GLB/GLTF behaviour).
                let headGroups = [];
                if (subdivision > 0) {
                    try {
                        const info = getPartInfo(assetDir);
                        headGroups = info.groups
                            .filter(
                                (g) =>
                                    !/^handle/i.test(g.name) &&
                                    (g.part === "Head" || /^head$/i.test(g.name))
                            )
                            .map((g) => g.name);
                    } catch {
                        headGroups = [];
                    }
                }

                const fbx = await buildFbx({
                    objText,
                    mtlText,
                    assetDir,
                    splitParts,
                    groupName,
                    embedTextures: !separate,
                    subdivision,
                    excludeSubdivision: headGroups,
                    rig,
                    moreJoints
                });

                if (separate) {
                    // Model + external textures in one ZIP.
                    const zip = new JSZip();
                    zip.file(`${userId}.fbx`, fbx);

                    const entries = await fs.readdir(assetDir);
                    for (const entry of entries) {
                        if (!/^texture\d+\.png$/i.test(entry)) {
                            continue;
                        }
                        zip.file(entry, await fs.readFile(path.join(assetDir, entry)));
                    }

                    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
                    res.setHeader("Content-Type", "application/zip");
                    res.setHeader(
                        "Content-Disposition",
                        `attachment; filename="${userId}.zip"`
                    );
                    return res.send(zipBuffer);
                }

                res.setHeader("Content-Type", "application/octet-stream");
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${userId}.fbx"`
                );
                return res.send(fbx);
            }

            let conversion;
            try {
                conversion = await convertAvatar(assetDir, {
                    rig,
                    splitParts,
                    groupName,
                    subdivision,
                    moreJoints
                });
            } catch (rigError) {
                // Auto-rig failed (e.g. not 6/15 Player groups).
                console.error("Auto-rig conversion failed:", rigError);
                return res.status(422).json({
                    success: false,
                    message: t(lang, "convert.rig_failed", { message: rigError.message })
                });
            }

            if (separate) {
                // ZIP with .gltf + .bin + textures
                const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aae-convert-"));
                try {
                    const files = await writeGltfSeparate(conversion.doc, tmpDir);
                    const zip = new JSZip();
                    const baseName = String(userId);
                    for (const file of files) {
                        const data = await fs.readFile(file.path);
                        // Rename model.gltf for clarity
                        const zipName = file.name === "model.gltf"
                            ? `${baseName}.gltf`
                            : file.name;
                        zip.file(zipName, data);
                    }
                    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

                    res.setHeader("Content-Type", "application/zip");
                    res.setHeader(
                        "Content-Disposition",
                        `attachment; filename="${baseName}.zip"`
                    );
                    return res.send(zipBuffer);
                } finally {
                    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
                }
            }

            const io = new NodeIO();
            if (fmt === "glb") {
                const tmpPath = path.join(os.tmpdir(), `aae-${userId}-${Date.now()}.glb`);
                await io.write(tmpPath, conversion.doc);
                const glbBuffer = await fs.readFile(tmpPath);
                await fs.unlink(tmpPath).catch(() => {});

                res.setHeader("Content-Type", "model/gltf-binary");
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${userId}.glb"`
                );
                return res.send(glbBuffer);
            } else {
                const gltfText = await writeGltfEmbedded(conversion.doc);

                res.setHeader("Content-Type", "model/gltf+json");
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${userId}.gltf"`
                );
                return res.send(gltfText);
            }
        } catch (err) {
            console.error("Convert error:", err);
            res.status(500).json({
                success: false,
                message: t(lang, "convert.failed")
            });
        }
    });
};