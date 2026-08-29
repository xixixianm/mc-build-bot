"use strict";
// User-supplied "extra build args" are dangerous by nature (arbitrary CLI
// flags to a build tool that runs shell/plugin code). We whitelist a small,
// safe subset instead of passing anything through.
const { ValidationError } = require("./errors");

const ALLOWED_FLAGS = new Set([
  // Maven
  "-q",
  "--quiet",
  "-X",
  "--debug",
  "-DskipTests",
  "-DskipTests=true",
  "-Dmaven.test.skip=true",
  "-U",
  "--update-snapshots",
  // Gradle
  "-x",
  "test",
  "--info",
  "--stacktrace",
  "-Pdebug",
]);

const MAX_ARGS = 6;

function parseExtraArgs(raw) {
  if (!raw || !raw.trim()) return [];
  const tokens = raw.trim().split(/\s+/).slice(0, MAX_ARGS + 1);
  if (tokens.length > MAX_ARGS) {
    throw new ValidationError(`Too many extra args (max ${MAX_ARGS}).`);
  }
  for (const t of tokens) {
    if (!ALLOWED_FLAGS.has(t)) {
      throw new ValidationError(
        `Unsupported build arg \`${t}\`. Allowed: ${[...ALLOWED_FLAGS].join(", ")}`
      );
    }
  }
  return tokens;
}

module.exports = { parseExtraArgs, ALLOWED_FLAGS };
