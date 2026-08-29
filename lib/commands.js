"use strict";
const { SlashCommandBuilder, REST, Routes } = require("discord.js");
const logger = require("./logger");

const log = logger.child({ mod: "commands" });

const commands = [
  new SlashCommandBuilder()
    .setName("build")
    .setDescription("Upload a .zip of plugin source to compile it into a .jar")
    .addAttachmentOption((opt) =>
      opt.setName("source").setDescription("A .zip file containing the plugin source (Maven or Gradle project)").setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName("java")
        .setDescription("Java version to build with (default: image default)")
        .addChoices({ name: "Java 17", value: "17" }, { name: "Java 21", value: "21" })
    )
    .addStringOption((opt) =>
      opt.setName("module").setDescription("Subfolder to build, for multi-module projects (e.g. plugin-core)")
    )
    .addStringOption((opt) =>
      opt.setName("args").setDescription("Extra build args, space-separated (whitelisted flags only)")
    ),
  new SlashCommandBuilder().setName("queue").setDescription("Show current build queue status"),
  new SlashCommandBuilder().setName("cancel").setDescription("Cancel your own currently running or queued build"),
  new SlashCommandBuilder().setName("history").setDescription("Show your recent build history"),
  new SlashCommandBuilder().setName("stats").setDescription("Show build stats (yours, or bot-wide for admins)"),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("Admin: view bot configuration")
    .setDefaultMemberPermissions(0),
].map((c) => c.toJSON());

async function registerCommands(token, clientId, guildId) {
  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
  await rest.put(route, { body: commands });
  log.info("slash commands registered", { scope: guildId ? `guild:${guildId}` : "global", count: commands.length });
}

module.exports = { commands, registerCommands };
