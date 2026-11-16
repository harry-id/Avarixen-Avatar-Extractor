const { spawn } = require("child_process");
const path = require("path");

const SERVERS = [
    { name: "Backend", dir: path.join(__dirname, "backend"), port: 3000 },
    { name: "Frontend", dir: path.join(__dirname, "frontend"), port: 3001 }
];

console.log("Starting Avarixen Avatar Extractor...");
console.log("------------------------------------");
console.log("Backend : http://localhost:3000");
console.log("Frontend: http://localhost:3001");
console.log("------------------------------------");

const children = [];
let shuttingDown = false;

function stopAll(signal) {
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
            try {
                child.kill(signal);
            } catch {
                // Process already gone; nothing to do.
            }
        }
    }
}

function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;

    stopAll("SIGTERM");

    // Let the children print their final output before the parent exits.
    setTimeout(() => process.exit(code), 300);
}

for (const server of SERVERS) {
    const child = spawn(process.execPath, ["server.js"], {
        cwd: server.dir,
        stdio: "inherit"
    });

    children.push(child);

    child.on("error", (error) => {
        console.error(`\n[${server.name}] failed to start: ${error.message}`);
        shutdown(1);
    });

    child.on("exit", (code, signal) => {
        if (shuttingDown) return;

        // Ctrl+C reaches the whole process group, so a signal exit is expected.
        if (signal === "SIGINT" || signal === "SIGTERM") {
            shutdown(0);
            return;
        }

        if (code === 0) {
            console.error(`\n[${server.name}] stopped unexpectedly.`);
        } else {
            console.error(`\n[${server.name}] exited with code ${code}.`);
        }

        console.error("Check the log above; a common cause is that the port is already in use.");
        shutdown(code === 0 ? 1 : code);
    });
}

process.on("SIGINT", () => {
    if (shuttingDown) {
        process.exit(1);
    }

    console.log("\nShutting down...");
    shutdown(0);
});

process.on("SIGTERM", () => shutdown(0));
