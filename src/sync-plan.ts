import type { TFile, Vault } from "obsidian";
import { normalizeDropboxPath } from "./dropbox";
import {
  isAdapterPath,
  shouldSyncPath,
  type SyncPathPolicy,
} from "./sync-policy";
import type { DropboxFileMetadata, SyncedFileState, VaultboxSyncState } from "./types";

export { shouldSyncPath } from "./sync-policy";

const DROPBOX_HASH_BLOCK_SIZE = 4 * 1024 * 1024;

export interface LocalFileSnapshot {
  path: string;
  pathLower: string;
  contentHash: string;
  size: number;
  mtime: number;
}

export type SyncConflictType =
  | "local-case-conflict"
  | "remote-case-conflict"
  | "path-shape-conflict"
  | "path-case-mismatch"
  | "both-new"
  | "both-modified"
  | "local-delete-remote-edit"
  | "local-edit-remote-delete";

export type SyncOperation =
  | {
      kind: "upload";
      path: string;
      local: LocalFileSnapshot;
      previous?: SyncedFileState;
    }
  | {
      kind: "download";
      path: string;
      remote: DropboxFileMetadata;
      previous?: SyncedFileState;
    }
  | {
      kind: "delete-remote";
      path: string;
      remote: DropboxFileMetadata;
      previous: SyncedFileState;
    }
  | {
      kind: "delete-local";
      path: string;
      previous: SyncedFileState;
    }
  | {
      kind: "noop";
      path: string;
      local?: LocalFileSnapshot;
      remote?: DropboxFileMetadata;
      previous?: SyncedFileState;
    };

export interface SyncConflict {
  kind: "conflict";
  type: SyncConflictType;
  path: string;
  message: string;
  local?: LocalFileSnapshot;
  remote?: DropboxFileMetadata;
  previous?: SyncedFileState;
  paths?: string[];
}

export interface SyncPlanSummary {
  uploads: number;
  downloads: number;
  remoteDeletes: number;
  localDeletes: number;
  noops: number;
  conflicts: number;
}

export interface SyncPlan {
  operations: SyncOperation[];
  conflicts: SyncConflict[];
  summary: SyncPlanSummary;
}

export async function scanLocalVault(
  vault: Vault,
  policy: SyncPathPolicy,
): Promise<Map<string, LocalFileSnapshot>> {
  const files = vault.getFiles().filter((file) => shouldSyncPath(file.path, policy));
  const snapshots = new Map<string, LocalFileSnapshot>();

  for (const file of files) {
    const content = await vault.readBinary(file);
    const snapshot = await createLocalSnapshot(file, content);
    addLocalSnapshot(snapshots, snapshot);
  }

  for (const allowedPath of policy.allowedConfigPaths) {
    await scanAdapterPath(vault, snapshots, allowedPath, policy);
  }
  for (const hiddenDir of policy.extraHiddenDirs) {
    await scanAdapterPath(vault, snapshots, hiddenDir, policy);
  }

  return snapshots;
}

export async function createLocalSnapshot(file: TFile, content: ArrayBuffer): Promise<LocalFileSnapshot> {
  return {
    path: file.path,
    pathLower: normalizePathKey(file.path),
    contentHash: await getDropboxContentHash(content),
    size: content.byteLength,
    mtime: file.stat.mtime,
  };
}

export function createSyncPlan(args: {
  localFiles: Map<string, LocalFileSnapshot>;
  remoteFiles: Map<string, DropboxFileMetadata>;
  state?: VaultboxSyncState;
}): SyncPlan {
  const previousFiles = new Map(Object.entries(args.state?.files ?? {}));
  const operations: SyncOperation[] = [];
  const conflicts: SyncConflict[] = [];
  const allKeys = new Set([
    ...args.localFiles.keys(),
    ...args.remoteFiles.keys(),
    ...previousFiles.keys(),
  ]);
  conflicts.push(...findPathShapeConflicts(args.localFiles, args.remoteFiles));

  if (conflicts.length > 0) {
    return {
      operations,
      conflicts,
      summary: summarizePlan(operations, conflicts),
    };
  }

  for (const pathLower of [...allKeys].sort()) {
    const local = args.localFiles.get(pathLower);
    const remote = args.remoteFiles.get(pathLower);
    const previous = previousFiles.get(pathLower);

    if (local && isLocalCaseConflictSnapshot(local)) {
      conflicts.push({
        kind: "conflict",
        type: "local-case-conflict",
        path: pathLower,
        message: `Multiple local files differ only by case: ${local.path}`,
        local,
        paths: local.path.split("\n"),
      });
      continue;
    }

    if (remote && (remote.pathLower !== pathLower || remote.pathDisplay.includes("\n"))) {
      conflicts.push({
        kind: "conflict",
        type: "remote-case-conflict",
        path: pathLower,
        message: `Multiple Dropbox files differ only by case: ${remote.pathDisplay || remote.pathLower}.`,
        remote,
        paths: remote.pathDisplay.split("\n"),
      });
      continue;
    }

    if (local && remote && local.path !== remoteRelativePath(remote)) {
      conflicts.push({
        kind: "conflict",
        type: "path-case-mismatch",
        path: pathLower,
        message: `Local and Dropbox paths differ only by case: ${local.path} vs ${remoteRelativePath(remote)}.`,
        local,
        remote,
        previous,
      });
      continue;
    }

    if (!previous) {
      planWithoutPrevious(pathLower, local, remote, operations, conflicts);
      continue;
    }

    planWithPrevious(pathLower, previous, local, remote, operations, conflicts);
  }

  return {
    operations,
    conflicts,
    summary: summarizePlan(operations, conflicts),
  };
}

function findPathShapeConflicts(
  localFiles: Map<string, LocalFileSnapshot>,
  remoteFiles: Map<string, DropboxFileMetadata>,
): SyncConflict[] {
  const conflicts = new Map<string, SyncConflict>();

  for (const localPath of localFiles.keys()) {
    for (const ancestorPath of ancestorPathsInclusive(localPath)) {
      if (ancestorPath === localPath || !remoteFiles.has(ancestorPath) || conflicts.has(ancestorPath)) {
        continue;
      }

      addPathShapeConflict(conflicts, ancestorPath, localFiles.get(localPath), remoteFiles.get(ancestorPath));
    }
  }

  for (const remotePath of remoteFiles.keys()) {
    for (const ancestorPath of ancestorPathsInclusive(remotePath)) {
      if (ancestorPath === remotePath || !localFiles.has(ancestorPath) || conflicts.has(ancestorPath)) {
        continue;
      }

      addPathShapeConflict(conflicts, ancestorPath, localFiles.get(ancestorPath), remoteFiles.get(remotePath));
    }
  }

  return [...conflicts.values()].sort((first, second) => first.path.localeCompare(second.path));
}

function addPathShapeConflict(
  conflicts: Map<string, SyncConflict>,
  blockingPath: string,
  local: LocalFileSnapshot | undefined,
  remote: DropboxFileMetadata | undefined,
): void {
  conflicts.set(blockingPath, {
    kind: "conflict",
    type: "path-shape-conflict",
    path: blockingPath,
    message: `A file/folder path conflict blocks sync near ${blockingPath}. Rename one side before syncing.`,
    local,
    remote,
    paths: [local?.path, remote ? remoteRelativePath(remote) : undefined].filter((path): path is string => Boolean(path)),
  });
}

function ancestorPathsInclusive(path: string): string[] {
  const ancestors = [path];
  let current = path;

  while (current.includes("/")) {
    current = current.slice(0, current.lastIndexOf("/"));
    if (current) {
      ancestors.push(current);
    }
  }

  return ancestors;
}

export function createRemoteFileSnapshot(
  remoteFiles: Map<string, DropboxFileMetadata>,
  rootPath: string,
  policy: SyncPathPolicy,
): Map<string, DropboxFileMetadata> {
  const root = normalizeDropboxPath(rootPath);
  const rootLower = root.toLowerCase();
  const result = new Map<string, DropboxFileMetadata>();

  for (const remote of remoteFiles.values()) {
    const relativeDisplay = stripRemoteRoot(remote.pathDisplay || remote.pathLower, root);
    const relativeLower = stripRemoteRoot(remote.pathLower, rootLower).toLowerCase();
    if (!relativeDisplay || !relativeLower || !shouldSyncPath(relativeDisplay, policy)) {
      continue;
    }
    const normalized: DropboxFileMetadata = {
      ...remote,
      pathDisplay: relativeDisplay,
      pathLower: normalizePathKey(relativeLower),
    };
    const existing = result.get(normalized.pathLower);
    if (existing) {
      result.set(normalized.pathLower, {
        ...normalized,
        pathDisplay: `${existing.pathDisplay}\n${normalized.pathDisplay}`,
      });
    } else {
      result.set(normalized.pathLower, normalized);
    }
  }

  return result;
}

export function formatSyncPlan(plan: SyncPlan, heading = "Simulation"): string {
  const lines = [
    `${heading}:`,
    `Uploads: ${plan.summary.uploads}`,
    `Downloads: ${plan.summary.downloads}`,
    `Remote deletes: ${plan.summary.remoteDeletes}`,
    `Local deletes: ${plan.summary.localDeletes}`,
    `Conflicts: ${plan.summary.conflicts}`,
  ];

  if (isPlanEmpty(plan)) {
    lines.push("", "No sync required. Everything is up to date.");
    return lines.join("\n");
  }

  const visible = plan.operations.filter((operation) => operation.kind !== "noop");
  for (const operation of visible.slice(0, 12)) {
    lines.push(`- ${formatOperation(operation)}`);
  }

  for (const conflict of plan.conflicts.slice(0, 12)) {
    lines.push(`- Conflict: ${conflict.message}`);
  }

  const remaining = visible.length + plan.conflicts.length - 24;
  if (remaining > 0) {
    lines.push(`- ${remaining} more planned changes not shown.`);
  }

  return lines.join("\n");
}

export function isPlanEmpty(plan: SyncPlan): boolean {
  return plan.summary.uploads === 0 &&
    plan.summary.downloads === 0 &&
    plan.summary.remoteDeletes === 0 &&
    plan.summary.localDeletes === 0 &&
    plan.summary.conflicts === 0;
}

export function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}

export function remoteRelativePath(remote: DropboxFileMetadata): string {
  return normalizeDropboxPath(remote.pathDisplay || remote.pathLower).replace(/^\/+/, "");
}

export async function getDropboxContentHash(content: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(content);
  const blockHashes: Uint8Array[] = [];

  for (let offset = 0; offset < bytes.length; offset += DROPBOX_HASH_BLOCK_SIZE) {
    const block = bytes.slice(offset, Math.min(offset + DROPBOX_HASH_BLOCK_SIZE, bytes.length));
    blockHashes.push(new Uint8Array(await crypto.subtle.digest("SHA-256", block)));
  }

  const combined = new Uint8Array(blockHashes.reduce((size, block) => size + block.length, 0));
  let offset = 0;
  for (const blockHash of blockHashes) {
    combined.set(blockHash, offset);
    offset += blockHash.length;
  }

  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", combined)));
}

function planWithoutPrevious(
  pathLower: string,
  local: LocalFileSnapshot | undefined,
  remote: DropboxFileMetadata | undefined,
  operations: SyncOperation[],
  conflicts: SyncConflict[],
): void {
  if (local && remote) {
    if (local.contentHash === remote.contentHash) {
      operations.push({ kind: "noop", path: pathLower, local, remote });
      return;
    }

    conflicts.push({
      kind: "conflict",
      type: "both-new",
      path: pathLower,
      message: `Local and Dropbox both contain unsynced versions of ${local.path}.`,
      local,
      remote,
    });
    return;
  }

  if (local) {
    operations.push({ kind: "upload", path: local.path, local });
    return;
  }

  if (remote) {
    operations.push({ kind: "download", path: remoteRelativePath(remote), remote });
  }
}

function planWithPrevious(
  pathLower: string,
  previous: SyncedFileState,
  local: LocalFileSnapshot | undefined,
  remote: DropboxFileMetadata | undefined,
  operations: SyncOperation[],
  conflicts: SyncConflict[],
): void {
  const localChanged = !local || local.contentHash !== previous.localContentHash;
  const remoteChanged = !remote ||
    remote.contentHash !== previous.remoteContentHash ||
    remote.rev !== previous.remoteRev;

  if (!localChanged && !remoteChanged) {
    operations.push({ kind: "noop", path: previous.path, local, remote, previous });
    return;
  }

  if (localChanged && !remoteChanged) {
    if (!local && remote) {
      operations.push({ kind: "delete-remote", path: previous.path, remote, previous });
    } else if (local) {
      operations.push({ kind: "upload", path: local.path, local, previous });
    }
    return;
  }

  if (!localChanged && remoteChanged) {
    if (!remote) {
      operations.push({ kind: "delete-local", path: previous.path, previous });
    } else {
      operations.push({ kind: "download", path: remoteRelativePath(remote), remote, previous });
    }
    return;
  }

  if (!local && !remote) {
    operations.push({ kind: "noop", path: previous.path, previous });
    return;
  }

  if (!local && remote) {
    conflicts.push({
      kind: "conflict",
      type: "local-delete-remote-edit",
      path: pathLower,
      message: `Local deleted ${previous.path}, but Dropbox changed it too.`,
      remote,
      previous,
    });
    return;
  }

  if (local && !remote) {
    conflicts.push({
      kind: "conflict",
      type: "local-edit-remote-delete",
      path: pathLower,
      message: `Local changed ${local.path}, but Dropbox deleted it.`,
      local,
      previous,
    });
    return;
  }

  if (local && remote && local.contentHash === remote.contentHash) {
    operations.push({ kind: "noop", path: local.path, local, remote, previous });
    return;
  }

  conflicts.push({
    kind: "conflict",
    type: "both-modified",
    path: pathLower,
    message: `Local and Dropbox both changed ${local?.path ?? previous.path}.`,
    local,
    remote,
    previous,
  });
}

function summarizePlan(operations: SyncOperation[], conflicts: SyncConflict[]): SyncPlanSummary {
  return {
    uploads: operations.filter((operation) => operation.kind === "upload").length,
    downloads: operations.filter((operation) => operation.kind === "download").length,
    remoteDeletes: operations.filter((operation) => operation.kind === "delete-remote").length,
    localDeletes: operations.filter((operation) => operation.kind === "delete-local").length,
    noops: operations.filter((operation) => operation.kind === "noop").length,
    conflicts: conflicts.length,
  };
}

function formatOperation(operation: SyncOperation): string {
  switch (operation.kind) {
    case "upload":
      return `Upload ${operation.path}`;
    case "download":
      return `Download ${operation.path}`;
    case "delete-remote":
      return `Delete from Dropbox ${operation.path}`;
    case "delete-local":
      return `Delete local ${operation.path}`;
    case "noop":
      return `No change ${operation.path}`;
  }
}

function createLocalCaseConflictSnapshot(first: LocalFileSnapshot, second: LocalFileSnapshot): LocalFileSnapshot {
  return {
    ...first,
    path: `${first.path}\n${second.path}`,
  };
}

async function scanAdapterPath(
  vault: Vault,
  snapshots: Map<string, LocalFileSnapshot>,
  path: string,
  policy: SyncPathPolicy,
): Promise<void> {
  if (!shouldSyncPath(path, policy) || !isAdapterPath(path, policy)) {
    return;
  }

  const stat = await vault.adapter.stat(path);
  if (!stat) {
    return;
  }

  if (stat.type === "file") {
    const content = await vault.adapter.readBinary(path);
    addLocalSnapshot(snapshots, {
      path,
      pathLower: normalizePathKey(path),
      contentHash: await getDropboxContentHash(content),
      size: content.byteLength,
      mtime: stat.mtime,
    });
    return;
  }

  const listed = await vault.adapter.list(path);
  for (const filePath of listed.files) {
    await scanAdapterPath(vault, snapshots, filePath, policy);
  }
  for (const folderPath of listed.folders) {
    await scanAdapterPath(vault, snapshots, folderPath, policy);
  }
}

function addLocalSnapshot(
  snapshots: Map<string, LocalFileSnapshot>,
  snapshot: LocalFileSnapshot,
): void {
  const existing = snapshots.get(snapshot.pathLower);
  snapshots.set(
    snapshot.pathLower,
    existing ? createLocalCaseConflictSnapshot(existing, snapshot) : snapshot,
  );
}

function isLocalCaseConflictSnapshot(snapshot: LocalFileSnapshot): boolean {
  return snapshot.path.includes("\n");
}

function stripRemoteRoot(path: string, rootPath: string): string {
  const normalizedPath = normalizeDropboxPath(path);
  const normalizedRoot = normalizeDropboxPath(rootPath);
  if (!normalizedRoot) {
    return normalizedPath.replace(/^\/+/, "");
  }

  if (normalizedPath.toLowerCase() === normalizedRoot.toLowerCase()) {
    return "";
  }

  const prefix = `${normalizedRoot}/`;
  if (normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return normalizedPath.slice(prefix.length).replace(/^\/+/, "");
  }

  return normalizedPath.replace(/^\/+/, "");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
