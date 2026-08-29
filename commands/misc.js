"use strict";
const { EmbedBuilder } = require("discord.js");
const queue = require("../lib/queue");
const db = require("../lib/db");
const { safeReplyOptions, fmtDuration, fmtBytes } = require("../lib/discord-helpers");
const { isAdmin } = require("../lib/access");
const { detectJavaHomes } = require("../lib/build");

async function handleQueue(interaction) {
  const { running, queued, capacity } = queue.queueSnapshot();
  await interaction.reply(safeReplyOptions(`**Build queue:** ${running}/${capacity} running, ${queued} waiting.`));
}

async function handleCancel(interaction) {
  const found = queue.findActiveJobFor(interaction.user.id);
  if (!found) {
    await interaction.reply(safeReplyOptions({ content: "You don't have an active build.", ephemeral: true }));
    return;
  }
  const [jobId, job] = found;
  job.status = "cancelled";
  if (job.cancelFn) job.cancelFn();
  await interaction.reply(safeReplyOptions("Cancelled your build."));
}

const STATUS_EMOJI = { success: "✅", failed: "❌", cancelled: "⏹️", error: "⚠️" };

async function handleHistory(interaction) {
  const rows = db.getHistory(interaction.user.id, 10);
  if (rows.length === 0) {
    await interaction.reply(safeReplyOptions({ content: "No build history yet.", ephemeral: true }));
    return;
  }
  const embed = new EmbedBuilder().setTitle("Your recent builds").setColor(0x5865f2);
  const lines = rows.map((r) => {
    const emoji = STATUS_EMOJI[r.status] || "•";
    const when = new Date(r.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const dur = r.duration_ms != null ? fmtDuration(r.duration_ms) : "n/a";
    return `${emoji} \`${r.build_type || "?"}\` ${when} — ${dur}${r.jar_name ? ` — ${r.jar_name}` : ""}`;
  });
  embed.setDescription(lines.join("\n"));
  await interaction.reply(safeReplyOptions({ embeds: [embed], ephemeral: true }));
}

async function handleStats(interaction) {
  const wantsGlobal = isAdmin(interaction);
  const stats = wantsGlobal ? db.getGlobalStats() : db.getUserStats(interaction.user.id);
  const embed = new EmbedBuilder().setTitle(wantsGlobal ? "Bot-wide build stats" : "Your build stats").setColor(0x5865f2);
  const fields = [
    { name: "Total builds", value: String(stats.total || 0), inline: true },
    { name: "Successes", value: String(stats.successes || 0), inline: true },
    { name: "Failures", value: String(stats.failures || 0), inline: true },
  ];
  if (wantsGlobal) {
    fields.push({ name: "Unique users", value: String(stats.users || 0), inline: true });
  } else {
    fields.push({ name: "Avg build time", value: stats.avg_duration_ms ? fmtDuration(stats.avg_duration_ms) : "n/a", inline: true });
    fields.push({
      name: "Last build",
      value: stats.last_build_at ? new Date(stats.last_build_at).toLocaleString() : "n/a",
      inline: true,
    });
  }
  embed.addFields(fields);
  await interaction.reply(safeReplyOptions({ embeds: [embed], ephemeral: true }));
}

async function handleConfig(interaction) {
  if (!isAdmin(interaction)) {
    await interaction.reply(safeReplyOptions({ content: "Admins only.", ephemeral: true }));
    return;
  }
  const { capacity } = queue.queueSnapshot();
  const javaHomes = detectJavaHomes();
  const embed = new EmbedBuilder()
    .setTitle("Bot configuration")
    .setColor(0x5865f2)
    .addFields(
      { name: "Max concurrent builds", value: String(capacity), inline: true },
      { name: "Per-user cooldown", value: `${queue.PER_USER_COOLDOWN_MS / 1000}s`, inline: true },
      { name: "DB mode", value: db.mode(), inline: true },
      { name: "Java versions available", value: Object.keys(javaHomes).sort().join(", ") || "none detected" }
    );
  await interaction.reply(safeReplyOptions({ embeds: [embed], ephemeral: true }));
}

module.exports = { handleQueue, handleCancel, handleHistory, handleStats, handleConfig };
