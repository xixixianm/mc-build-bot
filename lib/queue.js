"use strict";
const logger = require("./logger");
const { CancelledError } = require("./errors");

const log = logger.child({ mod: "queue" });

const MAX_CONCURRENT_BUILDS = Number(process.env.MAX_CONCURRENT_BUILDS || 1);
const PER_USER_COOLDOWN_MS = Number(process.env.PER_USER_COOLDOWN_MS || 15_000);

const jobs = new Map(); // jobId -> { userId, status, cancelFn, createdAt, ... }
const lastSubmitByUser = new Map();
let runningCount = 0;
const pendingQueue = [];

function queueSnapshot() {
  const running = [...jobs.values()].filter((j) => j.status === "running").length;
  return { running, queued: pendingQueue.length, capacity: MAX_CONCURRENT_BUILDS };
}

function cooldownRemaining(userId) {
  return PER_USER_COOLDOWN_MS - (Date.now() - (lastSubmitByUser.get(userId) || 0));
}

function markSubmitted(userId) {
  lastSubmitByUser.set(userId, Date.now());
}

function createJob(userId, meta = {}) {
  const jobId = require("crypto").randomUUID();
  const job = { userId, status: "queued", cancelFn: null, createdAt: Date.now(), ...meta };
  jobs.set(jobId, job);
  return { jobId, job };
}

function getJob(jobId) {
  return jobs.get(jobId);
}

function findActiveJobFor(userId) {
  return [...jobs.entries()].find(([, j]) => j.userId === userId && (j.status === "running" || j.status === "queued"));
}

function removeJob(jobId) {
  jobs.delete(jobId);
}

function enqueue(jobId, task) {
  return new Promise((resolve) => {
    pendingQueue.push({ jobId, task, resolve });
    log.debug("job enqueued", { jobId, queued: pendingQueue.length });
    drainQueue();
  });
}

function drainQueue() {
  if (runningCount >= MAX_CONCURRENT_BUILDS) return;
  const next = pendingQueue.shift();
  if (!next) return;
  const job = jobs.get(next.jobId);
  if (!job || job.status === "cancelled") {
    if (job) next.resolve({ cancelled: true });
    drainQueue();
    return;
  }
  runningCount++;
  job.status = "running";
  job.startedAt = Date.now();
  log.info("job started", { jobId: next.jobId, running: runningCount });
  next
    .task()
    .catch((err) => {
      log.error("job task threw", { jobId: next.jobId, err });
      return { code: -1, stdout: "", stderr: String((err && err.message) || err) };
    })
    .then((result) => {
      runningCount--;
      log.info("job finished", { jobId: next.jobId, code: result?.code, durationMs: result?.durationMs });
      next.resolve(result);
      drainQueue();
    });
}

module.exports = {
  queueSnapshot,
  cooldownRemaining,
  markSubmitted,
  createJob,
  getJob,
  findActiveJobFor,
  removeJob,
  enqueue,
  PER_USER_COOLDOWN_MS,
  MAX_CONCURRENT_BUILDS,
};
