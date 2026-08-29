"use strict";
// Same pipeline as /build, but runs the compiled jar through ProGuard
// before replying. See lib/obfuscate.js for how keep-rules are derived
// (fabric.mod.json entrypoints / plugin.yml main class) so obfuscation
// doesn't break the mod/plugin's own loader.
const { handleBuild } = require("./build");

async function handleBuildObfuscate(interaction) {
  return handleBuild(interaction, { obfuscate: true });
}

module.exports = { handleBuildObfuscate };
