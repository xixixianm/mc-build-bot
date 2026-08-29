"use strict";
// Structured logger. JSON lines in production (easy to ship to a log
// aggregator), colorized human-readable lines in development.
// No external deps — small enough to hand-roll and keeps the image lean.

const isProd = (process.env.NODE_ENV || "development") === "production";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

const COLORS = {
  debug: "\x1b[90m", // gray
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  reset: "\x1b[0m",
  dim: "\x1b[2m",
};

function serializeErr(err) {
  if (!(err instanceof Error)) return err;
  return { name: err.name, message: err.message, stack: err.stack, ...(err.cause ? { cause: serializeErr(err.cause) } : {}) };
}

function fmtMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) return "";
  const parts = Object.entries(meta).map(([k, v]) => {
    if (v instanceof Error) v = v.message;
    if (typeof v === "object" && v !== null) v = JSON.stringify(v);
    return `${k}=${v}`;
  });
  return parts.join(" ");
}

function baseLog(level, msg, meta = {}) {
  if (LEVELS[level] < configuredLevel) return;
  const time = new Date().toISOString();

  if (isProd) {
    const line = { level, time, msg, ...meta };
    if (meta.err) line.err = serializeErr(meta.err);
    process.stdout.write(JSON.stringify(line) + "\n");
    return;
  }

  const color = COLORS[level] || "";
  const metaStr = fmtMeta(meta);
  const out = `${COLORS.dim}${time}${COLORS.reset} ${color}${level.toUpperCase().padEnd(5)}${COLORS.reset} ${msg}${
    metaStr ? " " + COLORS.dim + metaStr + COLORS.reset : ""
  }`;
  (level === "error" ? process.stderr : process.stdout).write(out + "\n");
  if (meta.err instanceof Error && meta.err.stack) {
    (level === "error" ? process.stderr : process.stdout).write(meta.err.stack + "\n");
  }
}

function child(bindings = {}) {
  return {
    debug: (msg, meta) => baseLog("debug", msg, { ...bindings, ...meta }),
    info: (msg, meta) => baseLog("info", msg, { ...bindings, ...meta }),
    warn: (msg, meta) => baseLog("warn", msg, { ...bindings, ...meta }),
    error: (msg, meta) => baseLog("error", msg, { ...bindings, ...meta }),
    child: (more) => child({ ...bindings, ...more }),
  };
}

module.exports = child();
module.exports.child = child;
