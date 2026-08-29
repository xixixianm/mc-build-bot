// mc-build-bot
// Discord bot: upload a .zip of plugin source -> bot unzips, auto-detects
// Maven (pom.xml) or Gradle (build.gradle / build.gradle.kts), builds it,
// and replies with the compiled .jar (or the build error log if it fails).
//
// Slash commands: /build /buildobsfucate /cancel /queue /history /stats /config
//
// See lib/ for the actual implementation:
//   logger.js            structured logging (JSON in prod, pretty in dev)
//   errors.js            typed errors with safe user-facing messages
//   db.js                sqlite build history & stats (falls back to memory)
//   build.js             project detection + compiler invocation (fast flags)
//   obfuscate.js          ProGuard obfuscation pass for /buildobsfucate
//   queue.js             concurrency-capped build queue with per-user cooldown
//   access.js            allowlist / admin checks
//   args.js              whitelist for user-supplied extra build flags
//   discord-helpers.js   mention-safe replies, embeds, log attachments
//   commands.js          slash command schema + registration
//
// Safety notes:
// - Global allowedMentions is locked to parse: [] so the bot can never
//   ping @everyone/@here/roles/users, even accidentally via build output
//   or a filename — every outgoing message goes through safeReplyOptions().
// - User-supplied extra build args are whitelisted (lib/args.js), not
//   passed through raw, since they're arguments to a shell-spawned compiler.
// - Builds run through an in-process queue (concurrency + per-user cooldown)
//   instead of firing unbounded parallel mvn/gradle processes.

const { Client, GatewayIntentBits } = require("discord.js");
const logger = require("./lib/logger");
const { registerCommands } = require("./lib/commands");
const { safeReplyOptions, NO_MENTIONS } = require("./lib/discord-helpers");
const { handleBuild } = require("./commands/build");
const { handleBuildObfuscate } = require("./commands/buildobsfucate");
const { handleQueue, handleCancel, handleHistory, handleStats, handleConfig } = require("./commands/misc");
const queue = require("./lib/queue");
const access = require("./lib/access");

const log = logger.child({ mod: "main" });

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  log.error("missing required env vars", { missing: [!TOKEN && "DISCORD_TOKEN", !CLIENT_ID && "DISCORD_CLIENT_ID"].filter(Boolean) });
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: NO_MENTIONS,
});

const HANDLERS = {
  build: handleBuild,
  buildobsfucate: handleBuildObfuscate,
  queue: handleQueue,
  cancel: handleCancel,
  history: handleHistory,
  stats: handleStats,
  config: handleConfig,
};

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const handler = HANDLERS[interaction.commandName];
  if (!handler) return;

  const reqId = require("crypto").randomUUID().slice(0, 8);
  const cmdLog = log.child({ reqId, cmd: interaction.commandName, userId: interaction.user.id });
  const startedAt = Date.now();
  cmdLog.info("command received");

  try {
    await handler(interaction);
    cmdLog.info("command completed", { durationMs: Date.now() - startedAt });
  } catch (err) {
    cmdLog.error("unhandled command error", { err, durationMs: Date.now() - startedAt });
    const payload = safeReplyOptions({ content: "Something went wrong handling that command.", ephemeral: true });
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (replyErr) {
      cmdLog.error("failed to report error to user", { err: replyErr });
    }
  }
});

client.on("error", (err) => log.error("discord client error", { err }));
client.on("warn", (msg) => log.warn("discord client warning", { msg }));
client.on("shardError", (err) => log.error("discord shard error", { err }));

client.once("ready", () => {
  const { capacity } = queue.queueSnapshot();
  log.info("bot ready", {
    tag: client.user.tag,
    maxConcurrentBuilds: capacity,
    cooldownMs: queue.PER_USER_COOLDOWN_MS,
    allowlistEnabled: access.ALLOWED_USER_IDS.length > 0 || access.ALLOWED_ROLE_IDS.length > 0,
  });
});

function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  client.destroy();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  log.error("unhandled promise rejection", { err: reason instanceof Error ? reason : new Error(String(reason)) });
});
process.on("uncaughtException", (err) => {
  log.error("uncaught exception — exiting", { err });
  // An uncaught exception leaves the process in an unknown state; exit and
  // let the container orchestrator restart us rather than limp along.
  process.exit(1);
});

registerCommands(TOKEN, CLIENT_ID, GUILD_ID)
  .then(() => client.login(TOKEN))
  .catch((err) => {
    log.error("failed to register commands", { err });
    process.exit(1);
  });
