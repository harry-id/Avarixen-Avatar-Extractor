const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "127.0.0.1";

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
});

app.use("/assets", express.static(
path.join(__dirname, "../downloads")
));

// Serve only the UI entry point; do not expose server.js, package files,
// node_modules, or stray files that happen to live in this directory.
app.get(["/", "/index.html"], (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

const server = app.listen(PORT, HOST);

server.on("listening", () => {
    console.log(`AAE Frontend running at http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        console.error(
            `AAE Frontend failed: port ${PORT} is already in use. ` +
            `Stop the process using it (or set PORT to a free port) and try again.`
        );
    } else {
        console.error("AAE Frontend failed to start:", error.message);
    }

    process.exit(1);
});
