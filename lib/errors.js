"use strict";
// Typed errors so callers can react to *why* something failed instead of
// grepping message strings. Every user-facing error carries a short
// `userMessage` that's safe to show verbatim in Discord.

class BotError extends Error {
  constructor(message, { code = "UNKNOWN", userMessage, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.userMessage = userMessage || "Something went wrong.";
    if (cause) this.cause = cause;
  }
}

class ValidationError extends BotError {
  constructor(userMessage, opts = {}) {
    super(userMessage, { code: "VALIDATION", userMessage, ...opts });
  }
}

class DownloadError extends BotError {
  constructor(message, opts = {}) {
    super(message, { code: "DOWNLOAD", userMessage: "Couldn't download the attached file. Try re-uploading it.", ...opts });
  }
}

class ExtractError extends BotError {
  constructor(message, opts = {}) {
    super(message, {
      code: "EXTRACT",
      userMessage: "Couldn't extract the zip — it may be corrupted, encrypted, or not a valid zip file.",
      ...opts,
    });
  }
}

class ProjectDetectionError extends BotError {
  constructor(message, opts = {}) {
    super(message, {
      code: "PROJECT_DETECTION",
      userMessage: "Couldn't find a `pom.xml` or `build.gradle`/`build.gradle.kts` in the zip.",
      ...opts,
    });
  }
}

class BuildTimeoutError extends BotError {
  constructor(message, opts = {}) {
    super(message, { code: "BUILD_TIMEOUT", userMessage: "Build timed out and was killed.", ...opts });
  }
}

class BuildFailedError extends BotError {
  constructor(message, { log = "", ...opts } = {}) {
    super(message, { code: "BUILD_FAILED", userMessage: "Build failed.", ...opts });
    this.log = log;
  }
}

class ArtifactNotFoundError extends BotError {
  constructor(message, opts = {}) {
    super(message, {
      code: "ARTIFACT_NOT_FOUND",
      userMessage: "Build succeeded but no `.jar` was found in the expected output directory.",
      ...opts,
    });
  }
}

class ArtifactTooLargeError extends BotError {
  constructor(message, opts = {}) {
    super(message, { code: "ARTIFACT_TOO_LARGE", userMessage: "Build succeeded but the jar is too large to upload.", ...opts });
  }
}

class CancelledError extends BotError {
  constructor(message = "cancelled", opts = {}) {
    super(message, { code: "CANCELLED", userMessage: "Build cancelled.", ...opts });
  }
}

module.exports = {
  BotError,
  ValidationError,
  DownloadError,
  ExtractError,
  ProjectDetectionError,
  BuildTimeoutError,
  BuildFailedError,
  ArtifactNotFoundError,
  ArtifactTooLargeError,
  CancelledError,
};
