import { describe, expect, it } from "vitest";
import {
  createRemoteFileSnapshot,
  createSyncPlan,
  formatSyncPlan,
  getDropboxContentHash,
  normalizePathKey,
  scanLocalVault,
  shouldSyncPath,
  type LocalFileSnapshot,
} from "../src/sync-plan";
import { createSyncPathPolicy, filterSyncState } from "../src/sync-policy";
import { DEFAULT_SETTINGS, type DropboxFileMetadata, type SyncedFileState, type VaultboxSyncState } from "../src/types";

const DEFAULT_POLICY = createSyncPathPolicy(DEFAULT_SETTINGS, ".obsidian");

describe("sync planner", () => {
  it("excludes Obsidian configuration files from sync", () => {
    const policy = createSyncPathPolicy(DEFAULT_SETTINGS, ".custom-obsidian");
    expect(shouldSyncPath(".custom-obsidian/app.json", policy)).toBe(false);
    expect(shouldSyncPath(".obsidian/app.json", policy)).toBe(false);
    expect(shouldSyncPath("Notes/A.md", policy)).toBe(true);
    expect(normalizePathKey("/Notes/A.md")).toBe("notes/a.md");
  });

  it("normalizes remote Dropbox paths relative to the selected folder", () => {
    const remote = createRemoteFileSnapshot(
      new Map([
        [
          "/vaults/personal/notes/a.md",
          remoteFile("/Vaults/Personal/Notes/A.md", "hash-a", "rev-a"),
        ],
      ]),
      "/Vaults/Personal",
      DEFAULT_POLICY,
    );

    expect([...remote.keys()]).toEqual(["notes/a.md"]);
    expect(remote.get("notes/a.md")).toMatchObject({
      pathDisplay: "Notes/A.md",
      pathLower: "notes/a.md",
    });
  });

  it("filters remote configuration and hidden paths using the same policy as local files", () => {
    const policy = createSyncPathPolicy({
      ...DEFAULT_SETTINGS,
      syncThemes: true,
    }, ".obsidian");
    const remote = createRemoteFileSnapshot(
      new Map([
        ["/vault/note.md", remoteFile("/Vault/Note.md", "note", "rev-note")],
        ["/vault/.obsidian/app.json", remoteFile("/Vault/.obsidian/app.json", "app", "rev-app")],
        ["/vault/.obsidian/themes/example/theme.css", remoteFile("/Vault/.obsidian/themes/example/theme.css", "theme", "rev-theme")],
        ["/vault/.other/hidden.md", remoteFile("/Vault/.other/hidden.md", "hidden", "rev-hidden")],
      ]),
      "/Vault",
      policy,
    );

    expect([...remote.keys()].sort()).toEqual([
      ".obsidian/themes/example/theme.css",
      "note.md",
    ]);
  });

  it("leaves ignored Dropbox files untouched when old tracking data exists", () => {
    const path = ".obsidian/app.json";
    const policy = createSyncPathPolicy(DEFAULT_SETTINGS, ".obsidian");
    const remoteFiles = createRemoteFileSnapshot(
      new Map([[`/vault/${path}`, remoteFile(`/Vault/${path}`, "hash", "rev")]]),
      "/Vault",
      policy,
    );
    const previous = filterSyncState(state([synced(path, "hash", "hash", "rev")]), policy);
    const plan = createSyncPlan({
      localFiles: new Map(),
      remoteFiles,
      state: previous,
    });

    expect(plan.operations).toEqual([]);
    expect(plan.summary.remoteDeletes).toBe(0);
    expect(plan.summary.localDeletes).toBe(0);
  });

  it("enumerates enabled configuration and hidden directories through the adapter", async () => {
    const files = new Map<string, ArrayBuffer>([
      ["Note.md", bytes("note")],
      [".obsidian/themes/example/theme.css", bytes("theme")],
      [".claude/CLAUDE.md", bytes("instructions")],
      [".obsidian/workspace.json", bytes("workspace")],
    ]);
    const policy = createSyncPathPolicy({
      ...DEFAULT_SETTINGS,
      syncThemes: true,
      syncExtraHiddenDirs: [".claude"],
    }, ".obsidian");
    const vault = {
      getFiles: () => [{ path: "Note.md", stat: { mtime: 1 } }],
      readBinary: async (file: { path: string }) => files.get(file.path)!,
      adapter: {
        stat: async (path: string) => {
          const content = files.get(path);
          if (content) {
            return { type: "file", ctime: 1, mtime: 1, size: content.byteLength };
          }
          const prefix = `${path}/`;
          return [...files.keys()].some((filePath) => filePath.startsWith(prefix))
            ? { type: "folder", ctime: 1, mtime: 1, size: 0 }
            : null;
        },
        readBinary: async (path: string) => files.get(path)!,
        list: async (path: string) => listAdapterPath(files, path),
      },
    };

    const snapshots = await scanLocalVault(vault as never, policy);

    expect([...snapshots.keys()].sort()).toEqual([
      ".claude/claude.md",
      ".obsidian/themes/example/theme.css",
      "note.md",
    ]);
  });

  it("plans uploads and downloads for one-sided new files", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Local.md", "hash-local")),
      remoteFiles: remoteMap(remoteFile("Remote.md", "hash-remote", "rev-remote")),
    });

    expect(plan.summary).toMatchObject({
      uploads: 1,
      downloads: 1,
      conflicts: 0,
    });
    expect(plan.operations.map((operation) => operation.kind).sort()).toEqual(["download", "upload"]);
  });

  it("treats matching unsynced local and remote files as noops", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Same.md", "hash")),
      remoteFiles: remoteMap(remoteFile("Same.md", "hash", "rev")),
    });

    expect(plan.summary.noops).toBe(1);
    expect(plan.summary.conflicts).toBe(0);
    expect(formatSyncPlan(plan)).toContain("No sync required");
  });

  it("flags unsynced local and remote content at the same path as a conflict", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Same.md", "local")),
      remoteFiles: remoteMap(remoteFile("Same.md", "remote", "rev")),
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("both-new");
  });

  it("plans local edits, remote edits, and one-sided deletes from prior state", () => {
    const previous = state([
      synced("local-edit.md", "old", "old", "rev-old"),
      synced("remote-edit.md", "old", "old", "rev-old"),
      synced("local-delete.md", "old", "old", "rev-old"),
      synced("remote-delete.md", "old", "old", "rev-old"),
    ]);

    const plan = createSyncPlan({
      state: previous,
      localFiles: localMap(
        localFile("local-edit.md", "new-local"),
        localFile("remote-edit.md", "old"),
        localFile("remote-delete.md", "old"),
      ),
      remoteFiles: remoteMap(
        remoteFile("local-edit.md", "old", "rev-old"),
        remoteFile("remote-edit.md", "new-remote", "rev-new"),
        remoteFile("local-delete.md", "old", "rev-old"),
      ),
    });

    expect(plan.summary).toMatchObject({
      uploads: 1,
      downloads: 1,
      remoteDeletes: 1,
      localDeletes: 1,
      conflicts: 0,
    });
  });

  it("flags edit/delete and both-edited conflicts", () => {
    const previous = state([
      synced("both-edit.md", "old", "old", "rev-old"),
      synced("local-delete-remote-edit.md", "old", "old", "rev-old"),
      synced("local-edit-remote-delete.md", "old", "old", "rev-old"),
    ]);

    const plan = createSyncPlan({
      state: previous,
      localFiles: localMap(
        localFile("both-edit.md", "new-local"),
        localFile("local-edit-remote-delete.md", "new-local"),
      ),
      remoteFiles: remoteMap(
        remoteFile("both-edit.md", "new-remote", "rev-new"),
        remoteFile("local-delete-remote-edit.md", "new-remote", "rev-new"),
      ),
    });

    expect(plan.summary.conflicts).toBe(3);
    expect(plan.conflicts.map((conflict) => conflict.type).sort()).toEqual([
      "both-modified",
      "local-delete-remote-edit",
      "local-edit-remote-delete",
    ]);
  });

  it("flags case-only path mismatches before planning content changes", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Notes/A.md", "hash")),
      remoteFiles: remoteMap(remoteFile("notes/a.md", "hash", "rev")),
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("path-case-mismatch");
  });

  it("flags local files that block remote folder paths", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Notes", "local")),
      remoteFiles: remoteMap(remoteFile("Notes/A.md", "remote", "rev")),
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("path-shape-conflict");
    expect(plan.conflicts[0]?.path).toBe("notes");
    expect(plan.summary.uploads).toBe(0);
    expect(plan.summary.downloads).toBe(0);
  });

  it("flags remote files that block local folder paths", () => {
    const plan = createSyncPlan({
      localFiles: localMap(localFile("Notes/A.md", "local")),
      remoteFiles: remoteMap(remoteFile("Notes", "remote", "rev")),
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("path-shape-conflict");
    expect(plan.conflicts[0]?.path).toBe("notes");
    expect(plan.summary.uploads).toBe(0);
    expect(plan.summary.downloads).toBe(0);
  });

  it("flags local files that differ only by case", () => {
    const plan = createSyncPlan({
      localFiles: localMap({
        ...localFile("Notes/A.md", "hash"),
        path: "Notes/A.md\nnotes/a.md",
      }),
      remoteFiles: new Map(),
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("local-case-conflict");
  });

  it("flags remote files that differ only by case", () => {
    const remote = createRemoteFileSnapshot(
      new Map([
        ["notes/a.md", remoteFile("/Vault/Notes/A.md", "hash-a", "rev-a")],
        ["notes/a-copy.md", remoteFile("/Vault/notes/a.md", "hash-b", "rev-b")],
      ]),
      "/Vault",
      DEFAULT_POLICY,
    );

    const plan = createSyncPlan({
      localFiles: new Map(),
      remoteFiles: remote,
    });

    expect(plan.summary.conflicts).toBe(1);
    expect(plan.conflicts[0]?.type).toBe("remote-case-conflict");
  });

  it("treats matching local and remote edits as converged", () => {
    const plan = createSyncPlan({
      state: state([synced("Same.md", "old", "old", "rev-old")]),
      localFiles: localMap(localFile("Same.md", "new")),
      remoteFiles: remoteMap(remoteFile("Same.md", "new", "rev-new")),
    });

    expect(plan.summary.conflicts).toBe(0);
    expect(plan.summary.noops).toBe(1);
  });

  it("uses Dropbox content hashes for local content comparisons", async () => {
    const first = await getDropboxContentHash(new TextEncoder().encode("same").buffer);
    const second = await getDropboxContentHash(new TextEncoder().encode("same").buffer);
    const different = await getDropboxContentHash(new TextEncoder().encode("different").buffer);

    expect(first).toBe(second);
    expect(first).not.toBe(different);
  });
});

function localMap(...files: LocalFileSnapshot[]): Map<string, LocalFileSnapshot> {
  return new Map(files.map((file) => [file.pathLower, file]));
}

function remoteMap(...files: DropboxFileMetadata[]): Map<string, DropboxFileMetadata> {
  return new Map(files.map((file) => [file.pathLower, file]));
}

function localFile(path: string, contentHash: string): LocalFileSnapshot {
  return {
    path,
    pathLower: normalizePathKey(path),
    contentHash,
    size: 1,
    mtime: 1,
  };
}

function remoteFile(path: string, contentHash: string, rev: string): DropboxFileMetadata {
  const normalized = normalizePathKey(path);
  return {
    tag: "file",
    name: path.split("/").pop() ?? path,
    pathDisplay: path,
    pathLower: normalized,
    id: `id:${normalized}`,
    clientModified: "2026-01-01T00:00:00Z",
    serverModified: "2026-01-01T00:00:01Z",
    rev,
    size: 1,
    contentHash,
  };
}

function synced(path: string, localContentHash: string, remoteContentHash: string, remoteRev: string): SyncedFileState {
  return {
    path,
    pathLower: normalizePathKey(path),
    localContentHash,
    remoteContentHash,
    remoteRev,
  };
}

function state(files: SyncedFileState[]): VaultboxSyncState {
  return {
    files: Object.fromEntries(files.map((file) => [file.pathLower, file])),
    lastSyncedAt: 1,
  };
}

function listAdapterPath(files: Map<string, ArrayBuffer>, path: string) {
  const prefix = `${path}/`;
  const directFiles = new Set<string>();
  const directFolders = new Set<string>();

  for (const filePath of files.keys()) {
    if (!filePath.startsWith(prefix)) {
      continue;
    }
    const relative = filePath.slice(prefix.length);
    const separator = relative.indexOf("/");
    if (separator === -1) {
      directFiles.add(filePath);
    } else {
      directFolders.add(`${path}/${relative.slice(0, separator)}`);
    }
  }

  return {
    files: [...directFiles],
    folders: [...directFolders],
  };
}

function bytes(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}
