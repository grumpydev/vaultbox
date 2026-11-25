import {
  getOperationTargetPath,
  isResolvableConflict,
  remoteRelativePath,
  summarizePlan,
  type SyncConflict,
  type SyncOperation,
  type SyncPlan,
} from "./sync-plan";
import type { ConflictResolutionMode } from "./types";

/**
 * What to do with one conflicted file.
 *
 * `keep-local` and `keep-remote` mean "this side's state wins", which for a delete/edit
 * conflict means the delete is applied rather than the file restored.
 */
export type ConflictResolution = "keep-local" | "keep-remote" | "keep-both" | "skip";

export const CONFLICT_RESOLUTIONS: readonly ConflictResolution[] = [
  "keep-both",
  "keep-local",
  "keep-remote",
  "skip",
];

export interface ConflictPolicy {
  mode: ConflictResolutionMode;
  ambiguityWindowSeconds: number;
  /** Whether a conflict copy may be created at this path (config paths cannot hold one). */
  canCreateConflictCopy?: (path: string) => boolean;
}

export interface ResolutionOptions {
  /** Where the Dropbox version lands for `keep-both`. Required for a conflict copy. */
  conflictCopyPath?: string;
  /** Move an overwritten local file to the vault trash before replacing it. */
  trashOverwrittenLocal?: boolean;
}

const TEXT_FILE_PATTERN = /\.(md|markdown|txt)$/i;

export function isTextLikePath(path: string): boolean {
  return TEXT_FILE_PATTERN.test(path);
}

export function conflictLocalPath(conflict: SyncConflict): string {
  return conflict.local?.path ??
    conflict.previous?.path ??
    (conflict.remote ? remoteRelativePath(conflict.remote) : conflict.path);
}

/**
 * The resolution Vaultbox proposes for a conflict. In `newest-wins` mode the newer side
 * wins outright, but only when that is safe: edits always beat deletes, attachments and
 * near-simultaneous edits fall back to keeping both copies, and anything still ambiguous
 * is left for the user instead of guessed.
 */
export function chooseAutoResolution(conflict: SyncConflict, policy: ConflictPolicy): ConflictResolution {
  if (!isResolvableConflict(conflict)) {
    return "skip";
  }

  // A delete has no timestamp to compare, so never let one silently beat an edit.
  if (conflict.type === "local-edit-remote-delete") {
    return "keep-local";
  }
  if (conflict.type === "local-delete-remote-edit") {
    return "keep-remote";
  }

  const canKeepBoth = canCreateConflictCopy(conflict, policy);
  if (policy.mode === "ask") {
    return canKeepBoth ? "keep-both" : "skip";
  }

  const newest = compareConflictTimes(conflict, policy.ambiguityWindowSeconds);

  if (policy.mode === "keep-both") {
    return canKeepBoth ? "keep-both" : (newest ?? "skip");
  }

  if (!isTextLikePath(conflictLocalPath(conflict))) {
    // "Newer" is not a useful answer for an attachment nobody can diff.
    return canKeepBoth ? "keep-both" : (newest ?? "skip");
  }

  if (!newest) {
    return canKeepBoth ? "keep-both" : "skip";
  }

  return newest;
}

export function canCreateConflictCopy(conflict: SyncConflict, policy: ConflictPolicy): boolean {
  if (!conflict.local || !conflict.remote) {
    return false;
  }

  const copyPath = buildConflictCopyPath(conflictLocalPath(conflict), conflict.remote.serverModified);
  return policy.canCreateConflictCopy?.(copyPath) ?? true;
}

/**
 * `keep-local` when the local file is clearly newer, `keep-remote` when Dropbox is, and
 * `null` when the two times are unusable or too close together to call.
 */
export function compareConflictTimes(
  conflict: SyncConflict,
  ambiguityWindowSeconds: number,
): ConflictResolution | null {
  const localTime = conflict.local?.mtime;
  const remoteTime = conflict.remote ? Date.parse(conflict.remote.serverModified) : Number.NaN;

  if (typeof localTime !== "number" || !Number.isFinite(localTime) || !Number.isFinite(remoteTime)) {
    return null;
  }

  const windowMs = Math.max(0, ambiguityWindowSeconds) * 1_000;
  if (Math.abs(localTime - remoteTime) <= windowMs) {
    return null;
  }

  return localTime > remoteTime ? "keep-local" : "keep-remote";
}

export function formatConflictTimestamp(serverModified: string): string {
  const parsed = new Date(serverModified);
  const date = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    "-",
    pad(date.getMinutes()),
  ].join("");
}

export function buildConflictCopyPath(
  path: string,
  serverModified: string,
  isTaken: (candidate: string) => boolean = () => false,
): string {
  const separator = path.lastIndexOf("/");
  const directory = separator === -1 ? "" : path.slice(0, separator + 1);
  const fileName = separator === -1 ? path : path.slice(separator + 1);
  const dot = fileName.lastIndexOf(".");
  const base = dot <= 0 ? fileName : fileName.slice(0, dot);
  const extension = dot <= 0 ? "" : fileName.slice(dot);
  const label = `(Dropbox conflict ${formatConflictTimestamp(serverModified)})`;

  let candidate = `${directory}${base} ${label}${extension}`;
  let attempt = 2;
  while (isTaken(candidate)) {
    candidate = `${directory}${base} ${label} ${attempt}${extension}`;
    attempt += 1;
  }

  return candidate;
}

/**
 * Translate one decision into sync operations. `keep-both` produces two: the Dropbox
 * version is written beside the local file, and the local file is pushed to Dropbox, so
 * both devices end up holding both versions.
 */
export function resolutionToOperations(
  conflict: SyncConflict,
  resolution: ConflictResolution,
  options: ResolutionOptions = {},
): SyncOperation[] {
  if (resolution === "skip" || !isResolvableConflict(conflict)) {
    return [];
  }

  const keepLocal = upload(conflict);
  const keepRemote = download(conflict, options);

  if (conflict.type === "local-edit-remote-delete") {
    // Nothing remains on Dropbox, so "keep both" degrades to restoring the local file.
    if (resolution === "keep-remote") {
      return conflict.previous ? [{ kind: "delete-local", path: conflict.previous.path, previous: conflict.previous, force: true }] : [];
    }
    return keepLocal;
  }

  if (conflict.type === "local-delete-remote-edit") {
    // Nothing remains locally, so "keep both" degrades to restoring the Dropbox file.
    if (resolution === "keep-local") {
      return conflict.previous && conflict.remote
        ? [{ kind: "delete-remote", path: conflict.previous.path, remote: conflict.remote, previous: conflict.previous, force: true }]
        : [];
    }
    return keepRemote;
  }

  if (resolution === "keep-local") {
    return keepLocal;
  }

  if (resolution === "keep-remote") {
    return keepRemote;
  }

  if (!conflict.local || !conflict.remote || !options.conflictCopyPath) {
    return [];
  }

  // Order matters: the Dropbox version must be copied down before the local version
  // replaces it on Dropbox, or the copy would download the file it is meant to preserve.
  return [
    {
      kind: "download",
      path: remoteRelativePath(conflict.remote),
      remote: conflict.remote,
      targetPath: options.conflictCopyPath,
    },
    {
      kind: "upload",
      path: conflict.local.path,
      local: conflict.local,
      previous: conflict.previous,
      overwriteRemote: true,
    },
  ];
}

function upload(conflict: SyncConflict): SyncOperation[] {
  if (!conflict.local) {
    return [];
  }

  return [{
    kind: "upload",
    path: conflict.local.path,
    local: conflict.local,
    previous: conflict.previous,
    overwriteRemote: true,
  }];
}

function download(conflict: SyncConflict, options: ResolutionOptions): SyncOperation[] {
  if (!conflict.remote) {
    return [];
  }

  return [{
    kind: "download",
    path: remoteRelativePath(conflict.remote),
    remote: conflict.remote,
    overwriteLocal: true,
    trashExistingLocal: options.trashOverwrittenLocal ?? true,
  }];
}

export interface AppliedResolutions {
  plan: SyncPlan;
  resolved: number;
  skipped: number;
}

/**
 * Fold decisions into a plan: resolved conflicts become operations, skipped ones stay
 * listed as conflicts but no longer block the rest of the sync.
 */
export function applyResolutions(
  plan: SyncPlan,
  resolutions: Map<string, ConflictResolution>,
  buildCopyPath: (conflict: SyncConflict, isTaken: (candidate: string) => boolean) => string | undefined,
  options: Omit<ResolutionOptions, "conflictCopyPath"> = {},
): AppliedResolutions {
  const operations = [...plan.operations];
  const remaining: SyncConflict[] = [];
  const usedTargets = new Set(operations.map((operation) => getOperationTargetPath(operation).toLowerCase()));
  let resolved = 0;

  for (const conflict of plan.conflicts) {
    const resolution = resolutions.get(conflict.path) ?? "skip";
    if (resolution === "skip" || !isResolvableConflict(conflict)) {
      remaining.push(conflict);
      continue;
    }

    const conflictCopyPath = resolution === "keep-both"
      ? buildCopyPath(conflict, (candidate) => usedTargets.has(candidate.toLowerCase()))
      : undefined;
    if (resolution === "keep-both" && !conflictCopyPath) {
      remaining.push(conflict);
      continue;
    }

    const produced = resolutionToOperations(conflict, resolution, {
      ...options,
      conflictCopyPath,
    });
    if (produced.length === 0) {
      remaining.push(conflict);
      continue;
    }

    for (const operation of produced) {
      usedTargets.add(getOperationTargetPath(operation).toLowerCase());
      operations.push(operation);
    }
    resolved += 1;
  }

  return {
    plan: {
      operations,
      conflicts: remaining,
      summary: summarizePlan(operations, remaining),
    },
    resolved,
    skipped: remaining.length,
  };
}
