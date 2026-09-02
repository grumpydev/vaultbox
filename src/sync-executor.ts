import type { FileManager, TFile, Vault } from "obsidian";
import { normalizeDropboxPath } from "./dropbox";
import {
  getDropboxContentHash,
  normalizePathKey,
  type LocalFileSnapshot,
  type SyncOperation,
  type SyncPlan,
} from "./sync-plan";
import { isAdapterPath, shouldSyncPath, type SyncPathPolicy } from "./sync-policy";
import type { DropboxFileMetadata, SyncedFileState, VaultboxSyncState } from "./types";

const DEFAULT_UPLOAD_CONCURRENCY = 2;

export interface SyncDropboxClient {
  upload(args: { path: string; content: ArrayBuffer; rev?: string }): Promise<DropboxFileMetadata>;
  download(path: string): Promise<ArrayBuffer>;
  delete(path: string): Promise<unknown>;
  getMetadata(path: string): Promise<DropboxFileMetadata | { tag: "folder" }>;
  createFolder(path: string): Promise<void>;
}

export interface SyncExecutionResult {
  applied: number;
  state: VaultboxSyncState;
}

export interface SyncExecutionProgress {
  completed: number;
  total: number;
  operation: Exclude<SyncOperation["kind"], "noop">;
  path: string;
}

export class SyncExecutionError extends Error {
  constructor(
    message: string,
    readonly applied: number,
    readonly partialState: VaultboxSyncState,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "SyncExecutionError";
  }
}

class UploadRunError extends Error {
  constructor(
    message: string,
    readonly applied: number,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "UploadRunError";
  }
}

export async function executeSyncPlan(args: {
  vault: Vault;
  fileManager: FileManager;
  dropbox: SyncDropboxClient;
  rootPath: string;
  pathPolicy: SyncPathPolicy;
  plan: SyncPlan;
  currentState: VaultboxSyncState;
  uploadConcurrency?: number;
  onProgress?: (progress: SyncExecutionProgress) => void;
}): Promise<SyncExecutionResult> {
  if (args.plan.conflicts.length > 0) {
    throw new Error(`Cannot sync while ${args.plan.conflicts.length} conflict(s) need review.`);
  }

  for (const operation of args.plan.operations) {
    if (!shouldSyncPath(operation.path, args.pathPolicy)) {
      throw new Error(`Refusing to sync excluded or unsafe path: ${operation.path}`);
    }
  }

  assertUniqueChangeTargets(args.plan.operations);
  const files = canonicalizeStateFiles(args.currentState.files);
  const remoteFolderCache = new Set<string>();
  const total = args.plan.operations.filter((operation) => operation.kind !== "noop").length;
  let completed = 0;
  let applied = 0;
  const reportProgress = (operation: Exclude<SyncOperation, { kind: "noop" }>) => {
    completed += 1;
    args.onProgress?.({
      completed,
      total,
      operation: operation.kind,
      path: operation.path,
    });
  };

  const operations = args.plan.operations;
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.kind === "upload") {
      const uploadOperations: Array<Extract<SyncOperation, { kind: "upload" }>> = [];
      while (operations[index]?.kind === "upload") {
        uploadOperations.push(operations[index] as Extract<SyncOperation, { kind: "upload" }>);
        index += 1;
      }
      index -= 1;

      try {
        applied += await uploadLocalFiles({
          vault: args.vault,
          dropbox: args.dropbox,
          rootPath: args.rootPath,
          pathPolicy: args.pathPolicy,
          operations: uploadOperations,
          files,
          remoteFolderCache,
          concurrency: args.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY,
          onUploaded: reportProgress,
        });
      } catch (error) {
        if (error instanceof UploadRunError) {
          throw new SyncExecutionError(
            error.message,
            applied + error.applied,
            {
              files,
              lastSyncedAt: Date.now(),
            },
            error.cause,
          );
        }

        throw new SyncExecutionError(
          error instanceof Error ? error.message : String(error),
          applied,
          {
            files,
            lastSyncedAt: Date.now(),
          },
          error,
        );
      }

      continue;
    }

    try {
      await applyOperation({
        vault: args.vault,
        fileManager: args.fileManager,
        dropbox: args.dropbox,
        rootPath: args.rootPath,
        pathPolicy: args.pathPolicy,
        operation,
        files,
        remoteFolderCache,
      });
    } catch (error) {
      throw new SyncExecutionError(
        formatOperationError(operation, error),
        applied,
        {
          files,
          lastSyncedAt: Date.now(),
        },
        error,
      );
    }

    if (operation.kind !== "noop") {
      applied += 1;
      reportProgress(operation);
    }
  }

  return {
    applied,
    state: {
      files,
      lastSyncedAt: Date.now(),
    },
  };
}

function assertUniqueChangeTargets(operations: SyncOperation[]): void {
  const targets = new Set<string>();

  for (const operation of operations) {
    if (operation.kind === "noop") {
      continue;
    }

    const target = normalizePathKey(operation.path);
    if (targets.has(target)) {
      throw new Error(`Refusing multiple sync changes for the same path: ${operation.path}`);
    }
    targets.add(target);
  }
}

function canonicalizeStateFiles(files: Record<string, SyncedFileState>): Record<string, SyncedFileState> {
  const canonical: Record<string, SyncedFileState> = {};

  for (const file of Object.values(files)) {
    const pathLower = normalizePathKey(file.path);
    const existing = canonical[pathLower];
    if (existing && !sameSyncedState(existing, file)) {
      throw new Error(`Sync history contains conflicting entries for ${file.path}. Reset sync history before syncing.`);
    }
    canonical[pathLower] = { ...file, pathLower };
  }

  return canonical;
}

function sameSyncedState(first: SyncedFileState, second: SyncedFileState): boolean {
  return first.localContentHash === second.localContentHash &&
    first.remoteContentHash === second.remoteContentHash &&
    first.remoteRev === second.remoteRev;
}

async function uploadLocalFiles(args: {
  vault: Vault;
  dropbox: SyncDropboxClient;
  rootPath: string;
  pathPolicy: SyncPathPolicy;
  operations: Array<Extract<SyncOperation, { kind: "upload" }>>;
  files: Record<string, SyncedFileState>;
  remoteFolderCache: Set<string>;
  concurrency: number;
  onUploaded: (operation: Extract<SyncOperation, { kind: "upload" }>) => void;
}): Promise<number> {
  await ensureRemoteParentFoldersForUploads(args.dropbox, args.rootPath, args.operations, args.remoteFolderCache);

  let nextIndex = 0;
  let applied = 0;
  let failure: unknown = null;
  const concurrency = Math.max(1, Math.min(args.concurrency, args.operations.length));

  async function worker(): Promise<void> {
    while (!failure) {
      const operation = args.operations[nextIndex];
      nextIndex += 1;
      if (!operation) {
        return;
      }

      try {
        await uploadLocalFile({
          vault: args.vault,
          dropbox: args.dropbox,
          rootPath: args.rootPath,
          pathPolicy: args.pathPolicy,
          operation,
          files: args.files,
          remoteFolderCache: args.remoteFolderCache,
        });
        applied += 1;
        args.onUploaded(operation);
      } catch (error) {
        failure = new Error(formatOperationError(operation, error));
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (failure) {
    throw new UploadRunError(errorMessage(failure), applied, failure);
  }

  return applied;
}

async function applyOperation(args: {
  vault: Vault;
  fileManager: FileManager;
  dropbox: SyncDropboxClient;
  rootPath: string;
  pathPolicy: SyncPathPolicy;
  operation: SyncOperation;
  files: Record<string, SyncedFileState>;
  remoteFolderCache: Set<string>;
}): Promise<void> {
  const operation = args.operation;
  switch (operation.kind) {
    case "noop":
      applyNoop(operation, args.files);
      return;
    case "upload":
      await uploadLocalFile({ ...args, operation });
      return;
    case "download":
      await downloadRemoteFile({ ...args, operation });
      return;
    case "delete-remote":
      await deleteRemoteFile({ ...args, operation });
      return;
    case "delete-local":
      await deleteLocalFile({ ...args, operation });
      return;
  }
}

function applyNoop(operation: Extract<SyncOperation, { kind: "noop" }>, files: Record<string, SyncedFileState>): void {
  if (operation.local && operation.remote) {
    files[operation.local.pathLower] = createSyncedState(operation.local, operation.remote);
    return;
  }

  if (operation.previous && !operation.local && !operation.remote) {
    delete files[operation.previous.pathLower];
  }
}

async function uploadLocalFile(args: {
  vault: Vault;
  dropbox: SyncDropboxClient;
  rootPath: string;
  pathPolicy: SyncPathPolicy;
  operation: Extract<SyncOperation, { kind: "upload" }>;
  files: Record<string, SyncedFileState>;
  remoteFolderCache: Set<string>;
}): Promise<void> {
  const current = await readLocalSnapshot(
    args.vault,
    args.operation.local.path,
    isAdapterPath(args.operation.local.path, args.pathPolicy),
  );
  if (!current || current.snapshot.contentHash !== args.operation.local.contentHash) {
    throw new Error(`Local file changed before upload: ${args.operation.local.path}`);
  }

  const remotePath = toDropboxPath(args.rootPath, args.operation.local.path);
  await ensureRemoteParentFolders(args.dropbox, args.rootPath, remotePath, args.remoteFolderCache);
  const uploaded = await args.dropbox.upload({
    path: remotePath,
    content: current.content,
    rev: args.operation.previous?.remoteRev,
  });

  args.files[args.operation.local.pathLower] = {
    path: args.operation.local.path,
    pathLower: args.operation.local.pathLower,
    localContentHash: args.operation.local.contentHash,
    remoteContentHash: uploaded.contentHash || args.operation.local.contentHash,
    remoteRev: uploaded.rev,
  };
}

async function downloadRemoteFile(args: {
  vault: Vault;
  fileManager: FileManager;
  dropbox: SyncDropboxClient;
  rootPath: string;
  pathPolicy: SyncPathPolicy;
  operation: Extract<SyncOperation, { kind: "download" }>;
  files: Record<string, SyncedFileState>;
}): Promise<void> {
  const localPath = args.operation.path;
  const adapterPath = isAdapterPath(localPath, args.pathPolicy);
  const adapterStat = adapterPath ? await args.vault.adapter.stat(localPath) : null;
  if (adapterStat?.type === "folder" || (!adapterPath && args.vault.getFolderByPath(localPath))) {
    throw new Error(`Cannot download ${localPath}; a local folder already exists there.`);
  }

  const existing = await readLocalSnapshot(args.vault, localPath, adapterPath);

  if (args.operation.previous) {
    if (!existing || existing.snapshot.contentHash !== args.operation.previous.localContentHash) {
      throw new Error(`Local file changed before download: ${localPath}`);
    }
  } else if (existing) {
    throw new Error(`Local file appeared before download: ${localPath}`);
  }

  const content = await args.dropbox.download(toDropboxPath(args.rootPath, localPath));
  const contentHash = await getDropboxContentHash(content);
  if (contentHash !== args.operation.remote.contentHash) {
    throw new Error(`Dropbox file changed before download: ${localPath}`);
  }

  if (adapterPath) {
    await ensureAdapterParentFolders(args.vault, localPath);
    await args.vault.adapter.writeBinary(localPath, content);
  } else {
    await ensureParentFolders(args.vault, localPath);
    const file = args.vault.getFileByPath(localPath);
    if (file) {
      try {
        await args.vault.modifyBinary(file, content);
      } catch (error) {
        if (!isFileAlreadyExistsError(error)) {
          throw error;
        }

        await args.fileManager.trashFile(file);
        await ensureParentFolders(args.vault, localPath);
        await args.vault.createBinary(localPath, content);
      }
    } else {
      await args.vault.createBinary(localPath, content);
    }
  }

  args.files[normalizePathKey(localPath)] = {
    path: localPath,
    pathLower: normalizePathKey(localPath),
    localContentHash: contentHash,
    remoteContentHash: args.operation.remote.contentHash,
    remoteRev: args.operation.remote.rev,
  };
}

async function deleteRemoteFile(args: {
  vault: Vault;
  dropbox: SyncDropboxClient;
  rootPath: string;
  pathPolicy: SyncPathPolicy;
  operation: Extract<SyncOperation, { kind: "delete-remote" }>;
  files: Record<string, SyncedFileState>;
}): Promise<void> {
  const localPath = args.operation.previous.path;
  const localExists = isAdapterPath(localPath, args.pathPolicy)
    ? Boolean(await args.vault.adapter.stat(localPath))
    : Boolean(args.vault.getFileByPath(localPath));
  if (localExists) {
    throw new Error(`Local file reappeared before Dropbox delete: ${args.operation.previous.path}`);
  }

  const remotePath = toDropboxPath(args.rootPath, args.operation.previous.path);
  const current = await args.dropbox.getMetadata(remotePath);
  if (current.tag !== "file" || current.rev !== args.operation.previous.remoteRev) {
    throw new Error(`Dropbox file changed before delete: ${args.operation.previous.path}`);
  }

  await args.dropbox.delete(remotePath);
  delete args.files[args.operation.previous.pathLower];
}

async function deleteLocalFile(args: {
  vault: Vault;
  fileManager: FileManager;
  dropbox: SyncDropboxClient;
  rootPath: string;
  pathPolicy: SyncPathPolicy;
  operation: Extract<SyncOperation, { kind: "delete-local" }>;
  files: Record<string, SyncedFileState>;
}): Promise<void> {
  const localPath = args.operation.previous.path;
  const adapterPath = isAdapterPath(localPath, args.pathPolicy);
  const current = await readLocalSnapshot(args.vault, localPath, adapterPath);
  if (!current) {
    delete args.files[args.operation.previous.pathLower];
    return;
  }

  if (current.snapshot.contentHash !== args.operation.previous.localContentHash) {
    throw new Error(`Local file changed before delete: ${localPath}`);
  }

  const remotePath = toDropboxPath(args.rootPath, localPath);
  await assertRemoteMissing(args.dropbox, remotePath, localPath);
  if (adapterPath) {
    await args.vault.adapter.remove(localPath);
  } else if (current.file) {
    await args.fileManager.trashFile(current.file);
  }
  delete args.files[args.operation.previous.pathLower];
}

async function readLocalSnapshot(
  vault: Vault,
  path: string,
  adapterPath: boolean,
): Promise<{ file: TFile | null; content: ArrayBuffer; snapshot: LocalFileSnapshot } | null> {
  if (adapterPath) {
    const stat = await vault.adapter.stat(path);
    if (!stat || stat.type !== "file") {
      return null;
    }

    const content = await vault.adapter.readBinary(path);
    return {
      file: null,
      content,
      snapshot: {
        path,
        pathLower: normalizePathKey(path),
        contentHash: await getDropboxContentHash(content),
        size: content.byteLength,
        mtime: stat.mtime,
      },
    };
  }

  const file = vault.getFileByPath(path);
  if (!file) {
    return null;
  }

  const content = await vault.readBinary(file);
  return {
    file,
    content,
    snapshot: {
      path: file.path,
      pathLower: normalizePathKey(file.path),
      contentHash: await getDropboxContentHash(content),
      size: content.byteLength,
      mtime: file.stat.mtime,
    },
  };
}

async function ensureAdapterParentFolders(vault: Vault, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const stat = await vault.adapter.stat(current);
    if (!stat) {
      await vault.adapter.mkdir(current);
    } else if (stat.type !== "folder") {
      throw new Error(`Cannot create folder ${current}; a file already exists there.`);
    }
  }
}

async function ensureParentFolders(vault: Vault, path: string): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!vault.getFolderByPath(current)) {
      await vault.createFolder(current);
    }
  }
}

async function ensureRemoteParentFoldersForUploads(
  dropbox: SyncDropboxClient,
  rootPath: string,
  operations: Array<Extract<SyncOperation, { kind: "upload" }>>,
  createdFolders: Set<string>,
): Promise<void> {
  const folders = new Map<string, string>();

  for (const operation of operations) {
    for (const folder of getRemoteParentFolders(rootPath, toDropboxPath(rootPath, operation.local.path))) {
      folders.set(folder.toLowerCase(), folder);
    }
  }

  const sortedFolders = [...folders.values()].sort((first, second) => {
    const firstDepth = first.split("/").length;
    const secondDepth = second.split("/").length;
    return firstDepth - secondDepth || first.localeCompare(second);
  });

  for (const folder of sortedFolders) {
    const cacheKey = folder.toLowerCase();
    if (createdFolders.has(cacheKey)) {
      continue;
    }

    await dropbox.createFolder(folder);
    createdFolders.add(cacheKey);
  }
}

async function ensureRemoteParentFolders(
  dropbox: SyncDropboxClient,
  rootPath: string,
  path: string,
  createdFolders: Set<string>,
): Promise<void> {
  for (const folder of getRemoteParentFolders(rootPath, path)) {
    const cacheKey = folder.toLowerCase();
    if (createdFolders.has(cacheKey)) {
      continue;
    }

    await dropbox.createFolder(folder);
    createdFolders.add(cacheKey);
  }
}

function getRemoteParentFolders(rootPath: string, path: string): string[] {
  const root = normalizeDropboxPath(rootPath);
  const fullPath = normalizeDropboxPath(path);
  const rootPrefix = root ? `${root}/` : "/";
  const relativePath = fullPath.toLowerCase().startsWith(rootPrefix.toLowerCase())
    ? fullPath.slice(rootPrefix.length)
    : fullPath.replace(/^\/+/, "");
  const parts = relativePath.split("/").filter(Boolean).slice(0, -1);
  let current = root;
  const folders: string[] = [];

  for (const part of parts) {
    current = normalizeDropboxPath(`${current}/${part}`);
    folders.push(current);
  }

  return folders;
}

async function assertRemoteMissing(dropbox: SyncDropboxClient, dropboxPath: string, localPath: string): Promise<void> {
  try {
    const metadata = await dropbox.getMetadata(dropboxPath);
    if (metadata.tag === "file") {
      throw new Error(`Dropbox file reappeared before local delete: ${localPath}`);
    }
  } catch (error) {
    if (error instanceof Error && isDropboxNotFoundError(error)) {
      return;
    }
    throw error;
  }
}

function createSyncedState(local: LocalFileSnapshot, remote: DropboxFileMetadata): SyncedFileState {
  return {
    path: local.path,
    pathLower: local.pathLower,
    localContentHash: local.contentHash,
    remoteContentHash: remote.contentHash,
    remoteRev: remote.rev,
  };
}

function toDropboxPath(rootPath: string, relativePath: string): string {
  return normalizeDropboxPath(`${normalizeDropboxPath(rootPath)}/${relativePath}`);
}

function isDropboxNotFoundError(error: Error): boolean {
  return error.message.includes("path/not_found") || error.message.includes("not_found");
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && /file already exists/i.test(error.message);
}

function formatOperationError(operation: SyncOperation, error: unknown): string {
  const message = errorMessage(error);
  return `${operation.kind} ${operation.path} failed: ${message}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Unknown error";
}
