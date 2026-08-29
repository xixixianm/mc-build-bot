"use strict";
const { EmbedBuilder, AttachmentBuilder } = require("discord.js");

const NO_MENTIONS = { parse: [] };
const INLINE_LOG_LIMIT = Number(process.env.INLINE_LOG_LIMIT || 1500);

function sanitizeMentions(text) {
  if (!text) return text;
  return text.replace(/@(everyone|here)/g, "@\u200b$1").replace(/<@&?(\d+)>/g, "<@\u200b$1>");
}

function safeReplyOptions(options) {
  const opts = typeof options === "string" ? { content: options } : { ...options };
  if (opts.content) opts.content = sanitizeMentions(opts.content);
  if (opts.embeds) {
    opts.embeds = opts.embeds.map((e) => {
      if (e instanceof EmbedBuilder) {
        const data = e.toJSON();
        if (data.description) data.description = sanitizeMentions(data.description);
        if (data.title) data.title = sanitizeMentions(data.title);
        if (data.fields) data.fields = data.fields.map((f) => ({ ...f, value: sanitizeMentions(f.value) }));
        return data;
      }
      return e;
    });
  }
  opts.allowedMentions = NO_MENTIONS;
  return opts;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function fmtDuration(ms) {
  if (ms == null) return "n/a";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function fmtBytes(bytes) {
  if (bytes == null) return "n/a";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function buildResultEmbed({ title, color, buildType, durationMs, fields = [], footer }) {
  const embed = new EmbedBuilder().setTitle(title).setColor(color);
  const allFields = [];
  if (buildType) allFields.push({ name: "Build type", value: buildType, inline: true });
  if (durationMs != null) allFields.push({ name: "Duration", value: fmtDuration(durationMs), inline: true });
  allFields.push(...fields);
  if (allFields.length) embed.addFields(allFields);
  if (footer) embed.setFooter({ text: footer });
  embed.setTimestamp(new Date());
  return embed;
}

// Send a build log either inline (in a code block) or as a .txt attachment
// if it's too long to read comfortably in a Discord message.
async function replyWithLog(interaction, title, log, { color = 0xed4245 } = {}) {
  const clean = sanitizeMentions(log || "(no output)");
  if (clean.length <= INLINE_LOG_LIMIT) {
    const embed = new EmbedBuilder().setTitle(title).setColor(color).setDescription(`\`\`\`\n${clean}\n\`\`\``);
    await interaction.editReply(safeReplyOptions({ embeds: [embed] }));
    return;
  }
  const buf = Buffer.from(clean, "utf8");
  const file = new AttachmentBuilder(buf, { name: "build-log.txt" });
  const embed = new EmbedBuilder().setTitle(title).setColor(color).setDescription("Full log attached (too long to inline).");
  await interaction.editReply(safeReplyOptions({ embeds: [embed], files: [file] }));
}

module.exports = {
  sanitizeMentions,
  safeReplyOptions,
  sanitizeFilename,
  fmtDuration,
  fmtBytes,
  buildResultEmbed,
  replyWithLog,
  NO_MENTIONS,
};
