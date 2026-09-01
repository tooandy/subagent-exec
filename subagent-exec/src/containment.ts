export function supportsWriteContainment(): boolean {
  return process.platform === "darwin";
}

export function sandboxedCommand(
  executable: string,
  args: string[],
  writablePaths: Array<string | undefined>
): { executable: string; args: string[] } {
  if (!supportsWriteContainment()) throw new Error("write containment is unavailable on this platform");
  const quote = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const writable = [...new Set((writablePaths.filter(Boolean) as string[]).map((path) => {
    try { return realpathSync.native(path); } catch { return resolve(path); }
  }))];
  const exceptions = writable.map((path) =>
    `(allow file-write* (literal "${quote(path)}") (subpath "${quote(path)}"))`
  ).join(" ");
  const profile = `(version 1) (allow default) (deny file-write*) ${exceptions}`;
  return { executable: "/usr/bin/sandbox-exec", args: ["-p", profile, executable, ...args] };
}
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
