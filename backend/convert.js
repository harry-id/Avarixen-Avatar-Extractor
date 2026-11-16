const fs = require("fs/promises");
const path = require("path");
const convert = require("obj2gltf");

module.exports = function (app) {
    app.get("/api/roblox/convert/:userId/:format", async (req, res) => {
        const { userId, format } = req.params;
        const fmt = (format || "").toLowerCase();

        if (!/^\d+$/.test(userId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid user ID."
            });
        }

        if (!["glb", "gltf"].includes(fmt)) {
            return res.status(501).json({
                success: false,
                message:
                    fmt === "fbx"
                        ? "FBX export is not supported in pure JavaScript. Use GLB, GLTF, or OBJ instead."
                        : "Unsupported format. Use glb, gltf, or zip."
            });
        }

        const assetDir = path.join(__dirname, "../downloads", userId);
        const objPath = path.join(assetDir, "avatar.obj");

        try {
            await fs.access(objPath);
        } catch {
            return res.status(404).json({
                success: false,
                message: "OBJ file not found. Download avatar first."
            });
        }

        try {
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
                message: "Conversion failed: " + err.message
            });
        }
    });
};
