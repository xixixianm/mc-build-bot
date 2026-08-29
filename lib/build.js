"use strict";
const { spawn } = require("child_process");
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const os = require("os");
const logger = require("./logger");
const {
  ExtractError,
  ProjectDetectionError,
  BuildTimeoutError,
  BuildFailedError,
  ArtifactNotFoundError,
} = require("./errors");

const log = logger.child({ mod: "build" });

const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 5 * 60 * 1000);
const CACHE_ROOT = process.env.BUILD_CACHE_DIR || path.join(os.tmpdir(), "mc-build-bot-cache");
const MAVEN_REPO = path.join(CACHE_ROOT, "m2-repo");
const GRADLE_HOME = path.join(CACHE_ROOT, "gradle-home");

// How many parallel Maven module threads to use. "1C" = 1 thread per core.
const MAVEN_THREADS = process.env.MAVEN_THREADS || "1C";

async function ensureCacheDirs() {
  await fs.mkdir(MAVEN_REPO, { recursive: true });
  await fs.mkdir(GRADLE_HOME, { recursive: true });
}

function buildEnv(javaHome) {
  const env = {
    ...process.env,
    MAVEN_OPTS: `${process.env.MAVEN_OPTS || ""} -Dmaven.repo.local=${MAVEN_REPO}`.trim(),
    GRADLE_USER_HOME: GRADLE_HOME,
    // Encourage the JVM to start fast and not over-allocate in a container.
    JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS || ""} -XX:+TieredCompilation -XX:TieredStopAtLevel=1`.trim(),
  };
  if (javaHome) env.JAVA_HOME = javaHome;
  return env;
}

// Detect available JDKs installed at predictable locations (see Dockerfile).
// Returns { "17": "/usr/lib/jvm/java-17-openjdk-amd64", "21": "..." }.
function detectJavaHomes() {
  const roots = ["/usr/lib/jvm"];
  const found = {};
  for (const root of roots) {
    if (!fssync.existsSync(root)) continue;
    for (const entry of fssync.readdirSync(root)) {
      const m = entry.match(/(\d+)/);
      if (m) found[m[1]] = path.join(root, entry);
    }
  }
  return found;
}

function run(cmd, args, cwd, { onSpawn, env, jobLog } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell: false, env });
    } catch (err) {
      reject(err);
      return;
    }
    if (onSpawn) onSpawn(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, BUILD_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      jobLog?.debug("stdout", { chunk: d.toString().slice(0, 200) });
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message, timedOut, durationMs: Date.now() - startedAt, spawnError: err });
    });
  });
}

// Find the directory that actually contains the build file, in case the
// zip has an extra top-level folder wrapping the project.
async function findProjectRoot(dir) {
  const candidates = ["pom.xml", "build.gradle", "build.gradle.kts"];
  async function search(current, depth) {
    if (depth > 4) return null;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (!e.isDirectory() && candidates.includes(e.name)) return current;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== "__MACOSX" && !e.name.startsWith(".")) {
        const found = await search(path.join(current, e.name), depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return search(dir, 0);
}

// Find every buildable module in the zip (for multi-module projects), not
// just the first one — used by /build's module picker.
async function findAllProjectRoots(dir) {
  const candidates = ["pom.xml", "build.gradle", "build.gradle.kts"];
  const roots = [];
  async function search(current, depth) {
    if (depth > 5) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => !e.isDirectory() && candidates.includes(e.name))) {
      roots.push(current);
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== "__MACOSX" && !["node_modules", ".git"].includes(e.name) && !e.name.startsWith(".")) {
        await search(path.join(current, e.name), depth + 1);
      }
    }
  }
  await search(dir, 0);
  return roots;
}

async function detectBuildType(projectRoot) {
  const files = await fs.readdir(projectRoot);
  if (files.includes("pom.xml")) return "maven";
  if (files.includes("build.gradle") || files.includes("build.gradle.kts")) return "gradle";
  return null;
}

async function findBuiltJar(projectRoot, buildType) {
  const outDirs =
    buildType === "maven"
      ? [path.join(projectRoot, "target")]
      : [path.join(projectRoot, "build", "libs")];

  for (const outDir of outDirs) {
    if (!fssync.existsSync(outDir)) continue;
    const files = await fs.readdir(outDir);
    const jars = files.filter((f) => f.endsWith(".jar") && !f.includes("sources") && !f.includes("javadoc"));
    if (jars.length === 0) continue;
    const withSizes = await Promise.all(
      jars.map(async (f) => {
        const stat = await fs.stat(path.join(outDir, f));
        return { f, size: stat.size, dir: outDir };
      })
    );
    withSizes.sort((a, b) => b.size - a.size);
    const best = withSizes[0];
    return { jarPath: path.join(best.dir, best.f), sizeBytes: best.size };
  }
  return null;
}

// Build args a caller can pass through /build's optional options.
// - javaVersion: "17" | "21" | ... (must be installed in the image)
// - extraArgs: user-supplied extra CLI args (validated/whitelisted upstream)
// - module: subdirectory to build, for multi-module projects
async function runBuild({ projectRoot, buildType, javaVersion, extraArgs = [], onSpawn, jobLog }) {
  const javaHomes = detectJavaHomes();
  let javaHome;
  if (javaVersion) {
    javaHome = javaHomes[javaVersion];
    if (!javaHome) {
      throw new BuildFailedError(`Requested Java ${javaVersion} not available`, {
        userMessage: `Java ${javaVersion} isn't installed in this build environment. Available: ${
          Object.keys(javaHomes).join(", ") || "none detected"
        }.`,
      });
    }
  }
  const env = buildEnv(javaHome);

  let result;
  if (buildType === "maven") {
    // -T uses multi-threaded module builds (big win on multi-module projects).
    // -o tries offline first for a speed win when deps are already cached,
    // falling back to online automatically only if that fails.
    const baseArgs = ["-B", "-T", MAVEN_THREADS, "clean", "package", ...extraArgs];
    result = await run("mvn", ["-o", ...baseArgs], projectRoot, { onSpawn, env, jobLog });
    if (result.code !== 0 && !result.timedOut) {
      jobLog?.info("offline maven build failed, retrying online", {});
      result = await run("mvn", baseArgs, projectRoot, { onSpawn, env, jobLog });
    }
  } else {
    const hasWrapper = fssync.existsSync(path.join(projectRoot, "gradlew"));
    const gradleArgs = ["build", "--no-daemon", "--build-cache", "--parallel", ...extraArgs];
    if (hasWrapper) {
      await run("chmod", ["+x", "gradlew"], projectRoot, { env });
      result = await run("./gradlew", gradleArgs, projectRoot, { onSpawn, env, jobLog });
    } else {
      result = await run("gradle", gradleArgs, projectRoot, { onSpawn, env, jobLog });
    }
  }
  return result;
}

module.exports = {
  ensureCacheDirs,
  detectJavaHomes,
  findProjectRoot,
  findAllProjectRoots,
  detectBuildType,
  findBuiltJar,
  runBuild,
  CACHE_ROOT,
};
