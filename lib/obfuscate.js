"use strict";
const { spawn } = require("child_process");
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const os = require("os");
const AdmZip = require("adm-zip");

const { ObfuscationError } = require("./errors");

// Path to the ProGuard CLI jar, installed in the Docker image.
const PROGUARD_JAR = process.env.PROGUARD_JAR || "/opt/proguard/proguard.jar";

// Inspect the built jar for fabric.mod.json (Fabric) or plugin.yml (Bukkit/
// Spigot/Paper) and return a list of fully-qualified class names that MUST
// survive obfuscation untouched (entrypoints Discord/the loader looks up by
// name — renaming these breaks the mod/plugin at load time).
function findRequiredKeepClasses(jarPath) {
  const zip = new AdmZip(jarPath);
  const keep = new Set();

  const fabricEntry = zip.getEntry("fabric.mod.json");
  if (fabricEntry) {
    const json = JSON.parse(zip.readAsText(fabricEntry));
    const entrypoints = json.entrypoints || {};
    for (const list of Object.values(entrypoints)) {
      for (const ep of list) {
        // Entrypoints can be a plain class name, or "class::method", or a
        // reference to a separate adapter — only the class part matters here.
        const cls = (typeof ep === "string" ? ep : ep.value || "").split("::")[0];
        if (cls) keep.add(cls);
      }
    }
  }

  const pluginYmlEntry = zip.getEntry("plugin.yml");
  if (pluginYmlEntry) {
    const text = zip.readAsText(pluginYmlEntry);
    const m = text.match(/^main:\s*(\S+)/m);
    if (m) keep.add(m[1]);
  }

  return [...keep];
}

function run(cmd, args, { env, timeoutMs = 2 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message });
    });
  });
}

// Obfuscate jarPath in place-ish: writes a new "<name>-obf.jar" alongside
// it and returns { obfJarPath, mappingPath, keepClasses, log }.
// Only renames symbols (dontoptimize/dontshrink) — safest option for a
// generically-uploaded project we can't fully static-analyze ourselves.
async function obfuscateJar(jarPath, { javaHome } = {}) {
  if (!fssync.existsSync(PROGUARD_JAR)) {
    throw new ObfuscationError(`ProGuard not installed in this image (expected at ${PROGUARD_JAR})`);
  }

  const keepClasses = findRequiredKeepClasses(jarPath);

  const dir = path.dirname(jarPath);
  const base = path.basename(jarPath, ".jar");
  const outJar = path.join(dir, `${base}-obf.jar`);
  const mapping = path.join(dir, `${base}-mapping.txt`);
  const configPath = path.join(os.tmpdir(), `proguard-${Date.now()}.pro`);

  const javaHomeToUse = javaHome || process.env.JAVA_HOME;
  const jmods = javaHomeToUse ? path.join(javaHomeToUse, "jmods") : null;

  const lines = [
    `-injars '${jarPath}'`,
    `-outjars '${outJar}'`,
    jmods && fssync.existsSync(jmods) ? `-libraryjars '${jmods}'` : "",
    `-dontoptimize`,
    `-dontshrink`,
    `-dontpreverify`,
    `-keepattributes *Annotation*,Signature,InnerClasses`,
    `-printmapping '${mapping}'`,
    // Always keep the manifest's Main-Class if present.
    `-keepclasseswithmembers public class * { public static void main(java.lang.String[]); }`,
    ...keepClasses.map((c) => `-keep class ${c} { *; }`),
  ].filter(Boolean);

  await fs.writeFile(configPath, lines.join("\n"), "utf8");

  const env = { ...process.env };
  if (javaHomeToUse) env.JAVA_HOME = javaHomeToUse;

  const javaBin = javaHomeToUse ? path.join(javaHomeToUse, "bin", "java") : "java";
  const result = await run(javaBin, ["-jar", PROGUARD_JAR, "@" + configPath], { env });

  await fs.rm(configPath, { force: true });

  if (result.code !== 0 || !fssync.existsSync(outJar)) {
    throw new ObfuscationError("ProGuard failed", { log: (result.stdout + "\n" + result.stderr).trim() });
  }

  return { obfJarPath: outJar, mappingPath: mapping, keepClasses, log: result.stdout };
}

module.exports = { obfuscateJar, findRequiredKeepClasses };
