"use strict";

/**
 * File logging for the AAE backend.
 *
 * Tees every console.log / warn / error / info call to a log file while
 * leaving the terminal output untouched (colors and all). The file copy is
 * cleaned of ANSI escape codes so it stays readable in any editor.
 *
 * Configuration (environment variables):
 *   AAE_LOG_FILE   Path to the log file. Defaults to <backend>/aae.log.
 *                  Set to "false" / "0" / "off" to disable file logging.
 *   AAE_LOG_LEVEL  Minimum level to write to the file: debug|info|warn|error.
 *                  Defaults to "info". Console output is not filtered.
 *   AAE_LOG_MAX_BYTES  Rotate the log when it grows past this size.
 *                  Defaults to 10 MiB. Set to "0" to disable rotation.
 *   AAE_LOG_MAX_FILES  Number of rotated files to keep (default 3).
 *
 * The logger is a thin wrapper: it patches the global console methods once and
 * keeps a write stream to the log file. Call initLogger() before anything else
 * logs (right after loading dotenv in server.js).
 */

const fs = require("fs");
const path = require("path");

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug ? console.debug.bind(console) : console.log.bind(console)
};

let stream = null;
let filePath = null;
let minLevel = LEVELS.info;
let patched = false;
let maxBytes = DEFAULT_MAX_BYTES;
let maxFiles = DEFAULT_MAX_FILES;
let bytesWritten = 0;

function parseLogLimit(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return fallback;
    }

    const number = Number(value);

    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * Shift `path` and its numbered backups (`path.1`, `path.2`, ...), keeping at
 * most `keep` rotated files. The current file becomes `path.1`.
 */
function rotateLogFile(targetPath, keep = DEFAULT_MAX_FILES) {
    const keepCount = Math.max(0, Math.floor(keep));

    if (keepCount === 0) {
        fs.rmSync(targetPath, { force: true });
        return;
    }

    // Remove backups beyond the configured retention first, including ones
    // left behind by a previous, larger AAE_LOG_MAX_FILES value.
    const directory = path.dirname(targetPath);
    const baseName = path.basename(targetPath);

    try {
        for (const entry of fs.readdirSync(directory)) {
            const match = entry.match(new RegExp(`^${escapeRegExp(baseName)}\\.(\\d+)$`));

            if (match && Number(match[1]) > keepCount) {
                fs.rmSync(path.join(directory, entry), { force: true });
            }
        }
    } catch {
        // A missing/unreadable directory is handled by the caller.
    }

    for (let i = keepCount; i >= 1; i--) {
        const source = i === 1 ? targetPath : `${targetPath}.${i - 1}`;
        const destination = `${targetPath}.${i}`;

        if (i === keepCount) {
            fs.rmSync(destination, { force: true });
        }

        if (fs.existsSync(source)) {
            fs.renameSync(source, destination);
        }
    }
}

function openStream() {
    // Create the file synchronously so a rotation check can always see it,
    // even before the write stream's asynchronous open completes.
    try {
        fs.closeSync(fs.openSync(filePath, "a", 0o600));
    } catch {
        // createWriteStream below will surface the real error.
    }

    stream = fs.createWriteStream(filePath, { flags: "a", mode: 0o600 });
    stream.on("error", () => {
        // If the log file becomes unwritable, fall back to console only.
        stream = null;
    });

    try {
        bytesWritten = fs.statSync(filePath).size;
    } catch {
        bytesWritten = 0;
    }
}

function rotateIfNeeded(extraBytes = 0) {
    // Never rotate while the stream is still opening: buffered writes have
    // not reached the file yet, so renaming here would lose them. The next
    // log line (after the stream is open) will perform the rotation.
    if (!stream || maxBytes <= 0 || stream.pending) {
        return;
    }

    if (bytesWritten + extraBytes <= maxBytes) {
        return;
    }

    try {
        stream.end();
        rotateLogFile(filePath, maxFiles);
        openStream();
    } catch {
        // Rotation must never break request handling. If it fails, restart
        // the stream in append mode and keep logging to the current file.
        try {
            openStream();
        } catch {
            stream = null;
        }
    }
}

function stripAnsi(value) {
    return String(value).replace(ANSI_PATTERN, "");
}

function isDisabled(value) {
    return value === "false" || value === "0" || value === "off";
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatArg(arg) {
    if (typeof arg === "string") {
        return arg;
    }
    if (arg instanceof Error) {
        return arg.stack || `${arg.name}: ${arg.message}`;
    }
    if (typeof arg === "object" && arg !== null) {
        try {
            return JSON.stringify(arg);
        } catch {
            return String(arg);
        }
    }
    return String(arg);
}

function timestamp() {
    const d = new Date();
    const pad = (n, width = 2) => String(n).padStart(width, "0");
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
        `${pad(d.getMilliseconds(), 3)}`
    );
}

function levelFor(method) {
    switch (method) {
        case "error": return "error";
        case "warn": return "warn";
        case "debug": return "debug";
        default: return "info";
    }
}

function writeLine(level, args) {
    if (!stream) {
        return;
    }

    if (LEVELS[level] < minLevel) {
        return;
    }

    const message = args.map(formatArg).join(" ");
    const line = `[${timestamp()}] [${level.toUpperCase()}] ${stripAnsi(message)}\n`;
    const lineBytes = Buffer.byteLength(line);

    rotateIfNeeded(lineBytes);

    if (!stream) {
        return;
    }

    try {
        stream.write(line);
        bytesWritten += lineBytes;
    } catch {
        // Never let logging crash the server.
    }
}

function patchConsole() {
    if (patched) {
        return;
    }
    patched = true;

    const methods = ["log", "info", "warn", "error", "debug"];

    for (const method of methods) {
        const originalFn = original[method] || original.log;

        console[method] = (...args) => {
            originalFn(...args);
            writeLine(levelFor(method), args);
        };
    }
}

/**
 * Initialise file logging. Safe to call multiple times; only the first call
 * takes effect.
 *
 * @param {object} [options]
 * @param {string} [options.file] - Explicit log file path (overrides env).
 * @returns {{ filePath: string|null, enabled: boolean }}
 */
function initLogger(options = {}) {
    if (stream) {
        return { filePath, enabled: true };
    }

    const envFile = process.env.AAE_LOG_FILE;
    const requested = options.file || envFile;

    if (isDisabled(requested)) {
        return { filePath: null, enabled: false };
    }

    const levelName = String(process.env.AAE_LOG_LEVEL || "info").toLowerCase();
    minLevel = LEVELS[levelName] !== undefined ? LEVELS[levelName] : LEVELS.info;

    maxBytes = parseLogLimit(process.env.AAE_LOG_MAX_BYTES, DEFAULT_MAX_BYTES);
    maxFiles = parseLogLimit(process.env.AAE_LOG_MAX_FILES, DEFAULT_MAX_FILES);

    filePath = requested
        ? path.resolve(requested)
        : path.join(__dirname, "aae.log");

    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });

        // Rotate an oversized file from a previous run before appending.
        if (maxBytes > 0) {
            try {
                if (fs.statSync(filePath).size >= maxBytes) {
                    rotateLogFile(filePath, maxFiles);
                }
            } catch {
                // Missing file is expected on first run.
            }
        }

        openStream();
    } catch {
        stream = null;
        return { filePath: null, enabled: false };
    }

    patchConsole();

    return { filePath, enabled: true };
}

module.exports = {
    initLogger,
    parseLogLimit,
    rotateLogFile,
    stripAnsi
};