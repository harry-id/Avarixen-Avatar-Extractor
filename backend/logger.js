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

function stripAnsi(value) {
    return String(value).replace(ANSI_PATTERN, "");
}

function isDisabled(value) {
    return value === "false" || value === "0" || value === "off";
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

    try {
        stream.write(line);
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

    filePath = requested
        ? path.resolve(requested)
        : path.join(__dirname, "aae.log");

    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        stream = fs.createWriteStream(filePath, { flags: "a" });
        stream.on("error", () => {
            // If the log file becomes unwritable, fall back to console only.
            stream = null;
        });
    } catch {
        stream = null;
        return { filePath: null, enabled: false };
    }

    patchConsole();

    return { filePath, enabled: true };
}

module.exports = { initLogger, stripAnsi };