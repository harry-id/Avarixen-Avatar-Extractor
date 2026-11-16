const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use("/assets", express.static(
path.join(__dirname, "../downloads")
));

app.use(express.static(__dirname));

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
