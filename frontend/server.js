const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use("/assets", express.static(
path.join(__dirname, "../downloads")
));

// Serve only the UI entry point; do not expose server.js, package files,
// node_modules, or stray files that happen to live in this directory.
app.get(["/", "/index.html"], (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

const server = app.listen(PORT);

server.on("listening", () => {
    console.log(`AAE Frontend running on port ${PORT}`);
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
