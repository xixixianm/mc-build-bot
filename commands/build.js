"use strict";
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const os = require("os");
const { AttachmentBuilder } = require("discord.js");

const logger = require("../lib/logger");
const db = require("../lib/db");
const queue = require("../lib/queue");
const { isAllowed } = require("../lib/access");
const {
  safeReplyOptions,
  sanitizeFilename,
  buildResultEmbed,
  replyWithLog,
  fmtDuration,
  fmtBytes,
} = require("../lib/discord-helpers");
const { parseExtraArgs } = require("../lib/args");
const {
  ensureCacheDirs,
  findProjectRoot,
  findAllProjectRoots,
  detectBuildType,
  findBuiltJar,
  runBuild,
} = require("../lib/build");
const {
  ValidationError,
  DownloadError,
  ExtractError,
  ProjectDetectionError,
  BuildFailedError,
  ArtifactNotFoundError,
  ArtifactTooLargeError,
  CancelledError,
} = require("../lib/errors");

const log = logger.child({ mod: "cmd:build" });

const MAX_ZIP_BYTES = Number(process.env.MAX_ZIP_BYTES || 25 * 1024 * 1024);
const MAX_JAR_BYTES = Number(process.env.MAX_JAR_BYTES || 8 * 1024 * 1024 * 1024);

async function handleBuild(interaction) {
  const reqLog = log.child({ userId: interaction.user.id, guildId: interaction.guildId });

  if (!isAllowed(interaction)) {
    await interaction.reply(safeReplyOptions({ content: "You're not allowed to use this command.", ephemeral: true }));
    return;
  }

  const cooldownLeft = queue.cooldownRemaining(interaction.user.id);
  if (cooldownLeft > 0) {
    await interaction.reply(
      safeReplyOptions({ content: `Slow down — try again in ${Math.ceil(cooldownLeft / 1000)}s.`, ephemeral: true })
    );
    return;
  }

  const attachment = interaction.options.getAttachment("source");
  const javaVersion = interaction.options.getString("java") || null;
  const requestedModule = interaction.options.getString("module") || null;
  const rawArgs = interaction.options.getString("args") || "";

  if (!attachment || !attachment.name.toLowerCase().endsWith(".zip")) {
    await interaction.reply(safeReplyOptions({ content: "Please attach a `.zip` file.", ephemeral: true }));
    return;
  }
  if (attachment.size > MAX_ZIP_BYTES) {
    await interaction.reply(
      safeReplyOptions({ content: `Zip is too large (max ${MAX_ZIP_BYTES / 1024 / 1024} MB).`, ephemeral: true })
    );
    return;
  }

  let extraArgs;
  try {
    extraArgs = parseExtraArgs(rawArgs);
  } catch (err) {
    if (err instanceof ValidationError) {
      await interaction.reply(safeReplyOptions({ content: err.userMessage, ephemeral: true }));
      return;
    }
    throw err;
  }

  queue.markSubmitted(interaction.user.id);

  const { jobId, job } = queue.createJob(interaction.user.id, { guildId: interaction.guildId, filename: attachment.name });
  const jobLog = reqLog.child({ jobId });
  const workDir = path.join(os.tmpdir(), `mc-build-${jobId}`);
  const zipPath = path.join(os.tmpdir(), `${jobId}.zip`);
  const startedAt = Date.now();

  const { queued } = queue.queueSnapshot();
  await interaction.reply(
    safeReplyOptions(queued > 0 ? `Queued (position ~${queued + 1}). Downloading and extracting zip...` : "Downloading and extracting zip...")
  );
  jobLog.info("build requested", { filename: attachment.name, sizeBytes: attachment.size, javaVersion, requestedModule, extraArgs });

  let outcome = { status: "error", errorCode: null, buildType: null, durationMs: null, jarSizeBytes: null, jarName: null };

  try {
    await ensureCacheDirs();
    await fs.mkdir(workDir, { recursive: true });

    // Download
    let buf;
    try {
      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(zipPath, buf);
    } catch (err) {
      throw new DownloadError(`download failed: ${err.message}`, { cause: err });
    }

    // Extract
    try {
      const unzipper = require("unzipper");
      await fssync.createReadStream(zipPath).pipe(unzipper.Extract({ path: workDir })).promise();
    } catch (err) {
      throw new ExtractError(`extract failed: ${err.message}`, { cause: err });
    }

    // Locate project(s)
    let projectRoot;
    if (requestedModule) {
      const candidate = path.join(workDir, requestedModule);
      if (!fssync.existsSync(candidate)) {
        const allRoots = await findAllProjectRoots(workDir);
        throw new ProjectDetectionError(`module not found: ${requestedModule}`, {
          userMessage:
            `Module \`${requestedModule}\` not found. ` +
            (allRoots.length
              ? `Detected buildable modules: ${allRoots.map((r) => path.relative(workDir, r) || ".").join(", ")}`
              : "No buildable modules detected at all."),
        });
      }
      projectRoot = candidate;
    } else {
      projectRoot = await findProjectRoot(workDir);
      if (!projectRoot) {
        throw new ProjectDetectionError("no pom.xml/build.gradle found in zip");
      }
    }

    const buildType = await detectBuildType(projectRoot);
    if (!buildType) {
      throw new ProjectDetectionError("unrecognized build type at project root");
    }
    outcome.buildType = buildType;

    // Check for other modules to hint the user next time (multi-module zips).
    const allRoots = await findAllProjectRoots(workDir);
    const moduleHint = allRoots.length > 1 && !requestedModule ? allRoots : null;

    const result = await queue.enqueue(jobId, async () => {
      await interaction.editReply(
        safeReplyOptions(
          `Detected **${buildType}** project${javaVersion ? ` (Java ${javaVersion})` : ""}. Building... (this can take a minute)`
        )
      );
      let child;
      job.cancelFn = () => child && child.kill("SIGKILL");
      return runBuild({
        projectRoot,
        buildType,
        javaVersion,
        extraArgs,
        onSpawn: (c) => (child = c),
        jobLog,
      });
    });

    if (result.cancelled || job.status === "cancelled") {
      throw new CancelledError();
    }
    job.status = "done";
    outcome.durationMs = result.durationMs;

    if (result.code !== 0) {
      const fullLog = (result.stderr || result.stdout || "(no output)").trim();
      throw new BuildFailedError(result.timedOut ? "build timed out" : "build exited non-zero", {
        log: fullLog,
        userMessage: result.timedOut ? "Build timed out and was killed." : "Build failed.",
      });
    }

    const found = await findBuiltJar(projectRoot, buildType);
    if (!found) {
      throw new ArtifactNotFoundError("no jar in output dir");
    }
    if (found.sizeBytes > MAX_JAR_BYTES) {
      throw new ArtifactTooLargeError(`jar too large: ${found.sizeBytes} bytes`);
    }

    const jarName = sanitizeFilename(path.basename(found.jarPath));
    outcome.status = "success";
    outcome.jarSizeBytes = found.sizeBytes;
    outcome.jarName = jarName;

    const jarAttachment = new AttachmentBuilder(found.jarPath, { name: jarName });
    const embed = buildResultEmbed({
      title: "✅ Build succeeded",
      color: 0x57f287,
      buildType,
      durationMs: result.durationMs,
      fields: [
        { name: "Jar", value: jarName, inline: true },
        { name: "Size", value: fmtBytes(found.sizeBytes), inline: true },
      ],
      footer: moduleHint ? `Multi-module zip detected — use /build module: to target a different one` : undefined,
    });
    await interaction.editReply(safeReplyOptions({ embeds: [embed], files: [jarAttachment] }));
    jobLog.info("build succeeded", { durationMs: result.durationMs, jarSizeBytes: found.sizeBytes });
  } catch (err) {
    job.status = "done";
    outcome.errorCode = err.code || "UNKNOWN";

    if (err instanceof BuildFailedError) {
      outcome.status = "failed";
      const embed = buildResultEmbed({
        title: err.message === "build timed out" ? "⏱️ Build timed out" : "❌ Build failed",
        color: 0xed4245,
        buildType: outcome.buildType,
        durationMs: outcome.durationMs,
      });
      await interaction.editReply(safeReplyOptions({ embeds: [embed] }));
      await replyWithLog(interaction, "Build log", err.log, { color: 0xed4245 }).catch(() => {});
      jobLog.warn("build failed", { errorCode: err.code });
    } else if (err instanceof CancelledError) {
      outcome.status = "cancelled";
      await interaction.editReply(safeReplyOptions("Build cancelled.")).catch(() => {});
      jobLog.info("build cancelled");
    } else if (err.userMessage) {
      outcome.status = "error";
      await interaction.editReply(safeReplyOptions(err.userMessage)).catch(() => {});
      jobLog.warn("build errored", { errorCode: err.code, err });
    } else {
      outcome.status = "error";
      jobLog.error("unexpected error in build handler", { err });
      await interaction.editReply(safeReplyOptions(`Something went wrong: \`${err.message}\``)).catch(() => {});
    }
  } finally {
    queue.removeJob(jobId);
    db.recordBuild({
      id: jobId,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      filename: attachment?.name,
      buildType: outcome.buildType,
      status: outcome.status,
      errorCode: outcome.errorCode,
      durationMs: outcome.durationMs ?? Date.now() - startedAt,
      jarSizeBytes: outcome.jarSizeBytes,
      jarName: outcome.jarName,
      javaVersion,
      createdAt: startedAt,
    });
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    fs.rm(zipPath, { force: true }).catch(() => {});
  }
}

module.exports = { handleBuild };
