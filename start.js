const { spawn } = require("child_process");
const path = require("path");

const BACKEND_DIR = path.join(__dirname, "backend");
const FRONTEND_DIR = path.join(__dirname, "frontend");

function run(cmd, args, cwd) {
    return spawn(cmd, args, { cwd, stdio: "inherit", shell: true });
}

console.log("Starting Avarixen Avatar Extractor...");
console.log("------------------------------------");
console.log("Backend : http://localhost:3000");
console.log("Frontend: http://localhost:3001");
console.log("------------------------------------");

const backend = run("npm", ["start"], BACKEND_DIR);
const frontend = run("npm", ["start"], FRONTEND_DIR);

let exited = false;

function onExit(name, code) {
    if (exited) return;
    exited = true;
    console.log(`\n${name} exited with code ${code}`);
    backend.kill();
    frontend.kill();
    process.exit(code !== null ? code : 1);
}

backend.on("exit", (code) => onExit("Backend", code));
frontend.on("exit", (code) => onExit("Frontend", code));

process.on("SIGINT", () => {
    console.log("\nShutting down...");
    backend.kill("SIGINT");
    frontend.kill("SIGINT");
    process.exit(0);
});

process.on("SIGTERM", () => {
    backend.kill("SIGTERM");
    frontend.kill("SIGTERM");
    process.exit(0);
});
