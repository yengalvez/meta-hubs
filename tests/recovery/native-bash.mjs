// Bind the native LOCAL helpers to the caller's interpreter before they
// replace PATH. This does not select a shell for production recovery commands.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function nativeShellEnvironment() {
  // Neither the version probe nor source calls may run inherited startup
  // files, exported shell options/functions or PostgreSQL configuration.
  return { PATH: "/opt/homebrew/bin:/usr/bin:/bin", LC_ALL: "C", LANG: "C", TZ: "UTC" };
}

export function resolveNativeBash(searchPath = process.env.PATH, explicitExecutable) {
  let executable;
  const candidates = explicitExecutable === undefined
    ? (searchPath ?? "/usr/bin:/bin").split(path.delimiter).map(directory => path.resolve(directory || ".", "bash"))
    : [explicitExecutable];
  if (explicitExecutable !== undefined && !path.isAbsolute(explicitExecutable)) throw new Error("native_bash_path_not_absolute");
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK); executable = fs.realpathSync(candidate); break;
    } catch { /* Match executable PATH lookup, not a later supported fallback. */ }
  }
  if (!executable) throw new Error("native_bash_missing");
  let version;
  try {
    version = execFileSync(executable, ["--noprofile", "--norc", "-c",
      'printf "%s.%s\\n" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"'], {
      env: nativeShellEnvironment(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 1024
    });
  } catch { throw new Error("native_bash_validation_failed"); }
  const match = /^(\d+)\.(\d+)\n$/.exec(version);
  if (!match) throw new Error("native_bash_validation_failed");
  if (Number(match[1]) < 4 || (Number(match[1]) === 4 && Number(match[2]) < 1)) throw new Error("native_bash_requires_4_1");
  return executable;
}

export function nativeBashArguments(library, program, argv = []) {
  // Keep source outside conditional contexts: ||/&&/if would suppress
  // errexit inside the library and could mask a failed initialization.
  return ["--noprofile", "--norc", "-c", `set -euo pipefail; source "$1"; ${program}`,
    "native-local", library, ...argv];
}
