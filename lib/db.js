"use strict";
// Lightweight persistence for build history & stats using better-sqlite3
// (synchronous, embedded, zero external services — fine for this workload).
// Falls back to an in-memory no-op store if better-sqlite3 isn't installed,
// so the bot still runs (without history) in minimal environments.

const path = require("path");
const fs = require("fs");
const logger = require("./logger");

const log = logger.child({ mod: "db" });

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "builds.sqlite3");

let db = null;
let mode = "memory";

function initReal() {
  const Database = require("better-sqlite3");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS builds (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      guild_id TEXT,
      filename TEXT,
      build_type TEXT,
      status TEXT NOT NULL,      -- success | failed | cancelled | error
      error_code TEXT,
      duration_ms INTEGER,
      jar_size_bytes INTEGER,
      jar_name TEXT,
      java_version TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_builds_user ON builds(user_id, created_at DESC);
  `);
  mode = "sqlite";
}

try {
  initReal();
  log.info("database ready", { mode, path: DB_PATH });
} catch (err) {
  log.warn("better-sqlite3 unavailable, falling back to in-memory history (lost on restart)", { err });
  db = { __rows: [] };
  mode = "memory";
}

function recordBuild(rec) {
  const row = {
    id: rec.id,
    user_id: rec.userId,
    guild_id: rec.guildId || null,
    filename: rec.filename || null,
    build_type: rec.buildType || null,
    status: rec.status,
    error_code: rec.errorCode || null,
    duration_ms: rec.durationMs ?? null,
    jar_size_bytes: rec.jarSizeBytes ?? null,
    jar_name: rec.jarName || null,
    java_version: rec.javaVersion || null,
    created_at: rec.createdAt || Date.now(),
  };
  try {
    if (mode === "sqlite") {
      db.prepare(
        `INSERT OR REPLACE INTO builds
         (id, user_id, guild_id, filename, build_type, status, error_code, duration_ms, jar_size_bytes, jar_name, java_version, created_at)
         VALUES (@id, @user_id, @guild_id, @filename, @build_type, @status, @error_code, @duration_ms, @jar_size_bytes, @jar_name, @java_version, @created_at)`
      ).run(row);
    } else {
      db.__rows.unshift(row);
      if (db.__rows.length > 5000) db.__rows.length = 5000;
    }
  } catch (err) {
    log.warn("failed to record build", { err, buildId: rec.id });
  }
}

function getHistory(userId, limit = 10) {
  try {
    if (mode === "sqlite") {
      return db
        .prepare(`SELECT * FROM builds WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(userId, limit);
    }
    return db.__rows.filter((r) => r.user_id === userId).slice(0, limit);
  } catch (err) {
    log.warn("failed to read history", { err, userId });
    return [];
  }
}

function getUserStats(userId) {
  try {
    if (mode === "sqlite") {
      const row = db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successes,
             SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failures,
             AVG(CASE WHEN status='success' THEN duration_ms END) AS avg_duration_ms,
             MAX(created_at) AS last_build_at
           FROM builds WHERE user_id = ?`
        )
        .get(userId);
      return row;
    }
    const rows = db.__rows.filter((r) => r.user_id === userId);
    const successes = rows.filter((r) => r.status === "success");
    return {
      total: rows.length,
      successes: successes.length,
      failures: rows.filter((r) => r.status === "failed").length,
      avg_duration_ms: successes.length
        ? successes.reduce((a, r) => a + (r.duration_ms || 0), 0) / successes.length
        : null,
      last_build_at: rows[0]?.created_at ?? null,
    };
  } catch (err) {
    log.warn("failed to compute stats", { err, userId });
    return { total: 0, successes: 0, failures: 0, avg_duration_ms: null, last_build_at: null };
  }
}

function getGlobalStats() {
  try {
    if (mode === "sqlite") {
      return db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS successes,
                  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failures,
                  COUNT(DISTINCT user_id) AS users
           FROM builds`
        )
        .get();
    }
    return {
      total: db.__rows.length,
      successes: db.__rows.filter((r) => r.status === "success").length,
      failures: db.__rows.filter((r) => r.status === "failed").length,
      users: new Set(db.__rows.map((r) => r.user_id)).size,
    };
  } catch (err) {
    log.warn("failed to compute global stats", { err });
    return { total: 0, successes: 0, failures: 0, users: 0 };
  }
}

module.exports = { recordBuild, getHistory, getUserStats, getGlobalStats, mode: () => mode };
