import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

export interface DataDirectoryOptions {
  dataDirectory?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export function resolveDataDirectory(options: DataDirectoryOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const configured = options.dataDirectory ?? env.PI_WORKBENCH_DATA_DIR;
  if (configured) {
    if (!isAbsolute(configured)) throw new TypeError("PI_WORKBENCH_DATA_DIR must be an absolute path");
    return resolve(configured);
  }
  const xdg = env.XDG_DATA_HOME;
  if (xdg) {
    if (!isAbsolute(xdg)) throw new TypeError("XDG_DATA_HOME must be an absolute path");
    return join(xdg, "pi-agent-workbench");
  }
  if (!isAbsolute(home)) throw new TypeError("Home directory must be an absolute path");
  return join(home, ".local", "share", "pi-agent-workbench");
}

export function resolveDatabasePath(options: DataDirectoryOptions = {}): string {
  return join(resolveDataDirectory(options), "workbench.sqlite");
}

export async function ensureDataDirectory(options: DataDirectoryOptions = {}): Promise<string> {
  const path = resolveDataDirectory(options);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}
