import { readdirSync, type Dirent } from "node:fs";
import path from "node:path";
import { isPersonaDiskPartitionDirName } from "./policy.js";

export const MAX_DISCOVERED_PERSONA_DISK_PARTITIONS = 256;

export interface ListPersistedPersonaPartitionsOptions {
  logWarn?: (message: string, details?: unknown) => void;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Scans Electron's `<userData>/Partitions/` directory for persistent Persona partition directories
 * (`persona` and safe `persona-*` prefixes) so full session clearing also sweeps cookies and
 * storage left behind by previously deleted Hubs without touching unrelated partitions such as
 * `paseo-browser`.
 */
export function listPersistedPersonaPartitions(
  userDataPath: string,
  options?: ListPersistedPersonaPartitionsOptions,
): string[] {
  const trimmedRoot = typeof userDataPath === "string" ? userDataPath.trim() : "";
  if (!trimmedRoot) {
    return [];
  }

  const partitionsDir = path.join(trimmedRoot, "Partitions");
  let entries: Dirent[];
  try {
    entries = readdirSync(partitionsDir, { withFileTypes: true });
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) {
      options?.logWarn?.("[persona-webview] failed to scan persisted Persona partition directory", {
        error,
      });
    }
    return [];
  }

  const discovered = new Set<string>();
  const sortedEntries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sortedEntries) {
    if (discovered.size >= MAX_DISCOVERED_PERSONA_DISK_PARTITIONS) {
      break;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    if (!isPersonaDiskPartitionDirName(entry.name)) {
      continue;
    }
    discovered.add(`persist:${entry.name}`);
  }

  return Array.from(discovered);
}
