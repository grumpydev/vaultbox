import type { VaultboxSettings, VaultboxSyncState } from "./types";

const RESERVED_HIDDEN_DIRS = new Set([".git", ".trash", ".vaultbox"]);
const RESERVED_FILES = new Set([".ds_store", ".gitignore"]);

export interface SyncPathPolicy {
  configDir: string;
  allowedConfigPaths: string[];
  extraHiddenDirs: string[];
  excludePatterns: string[];
}

export function createSyncPathPolicy(settings: VaultboxSettings, configDir: string): SyncPathPolicy {
  const normalizedConfigDir = normalizeVaultPath(configDir);
  if (!normalizedConfigDir) {
    throw new Error("Obsidian returned an invalid configuration directory.");
  }
  return {
    configDir: normalizedConfigDir,
    allowedConfigPaths: getConfigAllowedPaths(settings, normalizedConfigDir),
    extraHiddenDirs: getValidExtraHiddenDirs(settings, normalizedConfigDir),
    excludePatterns: getValidExcludePatterns(settings.syncExcludePaths),
  };
}

export function getConfigAllowedPaths(settings: VaultboxSettings, configDir: string): string[] {
  const paths: string[] = [];

  if (settings.syncCommunityPlugins) {
    paths.push(`${configDir}/community-plugins.json`);
  }
  if (settings.syncThemes) {
    paths.push(`${configDir}/themes`);
  }
  if (settings.syncSnippets) {
    paths.push(`${configDir}/snippets`);
  }

  return paths;
}

export function isValidExtraHiddenDir(name: string, configDir: string): boolean {
  const normalized = normalizeVaultPath(name);
  if (!normalized || normalized !== name.trim() || !normalized.startsWith(".") || normalized.includes("/")) {
    return false;
  }

  const lower = normalized.toLowerCase();
  return lower !== configDir.toLowerCase() && !RESERVED_HIDDEN_DIRS.has(lower);
}

export function getValidExtraHiddenDirs(settings: VaultboxSettings, configDir: string): string[] {
  const configured: unknown = settings.syncExtraHiddenDirs;
  if (!Array.isArray(configured)) {
    return [];
  }
  return uniqueCaseInsensitive(
    configured
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => isValidExtraHiddenDir(value, configDir)),
  );
}

export function getValidExcludePatterns(patterns: unknown): string[] {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return uniqueCaseInsensitive(
    patterns
      .filter((pattern): pattern is string => typeof pattern === "string")
      .map((pattern) => pattern.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
      .filter((pattern) => Boolean(pattern) && hasSafeSegments(pattern)),
  );
}

export function shouldSyncPath(path: string, policy: SyncPathPolicy): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized) {
    return false;
  }

  const lower = normalized.toLowerCase();
  const filename = lower.split("/").pop() ?? lower;
  if (RESERVED_FILES.has(filename)) {
    return false;
  }

  const configDir = policy.configDir.toLowerCase();
  if (isPathWithin(lower, configDir)) {
    if (!policy.allowedConfigPaths.some((allowed) => isPathWithin(lower, allowed.toLowerCase()))) {
      return false;
    }
    return !policy.excludePatterns.some((pattern) => matchesExcludePattern(lower, pattern));
  }

  const parts = lower.split("/");
  const firstSegment = parts[0] ?? "";
  if (firstSegment.startsWith(".")) {
    if (RESERVED_HIDDEN_DIRS.has(firstSegment)) {
      return false;
    }
    if (!policy.extraHiddenDirs.some((dir) => dir.toLowerCase() === firstSegment)) {
      return false;
    }
    return !policy.excludePatterns.some((pattern) => matchesExcludePattern(lower, pattern));
  }

  return !parts.slice(1).some((part) => part.startsWith("."));
}

export function isAdapterPath(path: string, policy: SyncPathPolicy): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized || !shouldSyncPath(normalized, policy)) {
    return false;
  }

  const lower = normalized.toLowerCase();
  if (isPathWithin(lower, policy.configDir.toLowerCase())) {
    return true;
  }

  const firstSegment = lower.split("/")[0] ?? "";
  return policy.extraHiddenDirs.some((dir) => dir.toLowerCase() === firstSegment);
}

export function filterSyncState(state: VaultboxSyncState, policy: SyncPathPolicy): VaultboxSyncState {
  return {
    files: Object.fromEntries(
      Object.entries(state.files).filter(([, file]) => shouldSyncPath(file.path, policy)),
    ),
    lastSyncedAt: state.lastSyncedAt,
  };
}

export function normalizeVaultPath(path: string): string | null {
  if (!path || path.startsWith("/") || path.includes("\0")) {
    return null;
  }

  const normalized = path.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized && hasSafeSegments(normalized) ? normalized : null;
}

export function matchesExcludePattern(path: string, pattern: string): boolean {
  const normalizedPath = path.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedPattern.includes("/")) {
    return isPathWithin(normalizedPath, normalizedPattern);
  }

  return (normalizedPath.split("/").pop() ?? "") === normalizedPattern;
}

function isPathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function hasSafeSegments(path: string): boolean {
  const parts = path.split("/");
  return parts.every((part) => Boolean(part) && part !== "." && part !== "..");
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const lower = value.toLowerCase();
    if (seen.has(lower)) {
      return false;
    }
    seen.add(lower);
    return true;
  });
}
