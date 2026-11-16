const fs = require("fs/promises");
const path = require("path");
const convert = require("obj2gltf");
const { getLang, t } = require("./i18n");
const { buildFbx } = require("./fbx-exporter");

const SUPPORTED_FORMATS = ["glb", "gltf", "fbx"];

module.exports = function (app) {
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

                const fbx = await buildFbx({ objText, mtlText, assetDir });

                res.setHeader("Content-Type", "application/octet-stream");
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${userId}.fbx"`
                );
                return res.send(fbx);
            }

            const binary = fmt === "glb";
            const result = await convert(objPath, {
                binary: binary,
                logger: () => {} // suppress verbose obj2gltf logging
            });

            if (binary) {
                // result is a Buffer (GLB)
                res.setHeader("Content-Type", "model/gltf-binary");
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${userId}.glb"`
                );
                res.send(result);
            } else {
                // result is a glTF JSON object
                const json = JSON.stringify(result, null, 2);
                res.setHeader("Content-Type", "model/gltf+json");
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${userId}.gltf"`
                );
                res.send(json);
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
