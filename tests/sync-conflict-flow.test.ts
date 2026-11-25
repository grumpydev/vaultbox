import { beforeEach, describe, expect, it, vi } from "vitest";

const { execute, requestConflictResolutions, confirm } = vi.hoisted(() => ({
  execute: vi.fn(),
  requestConflictResolutions: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../src/settings-tab", () => ({ VaultboxSettingTab: class {} }));
vi.mock("../src/confirmation-modal", () => ({ requestConfirmation: confirm }));
vi.mock("../src/conflict-modal", () => ({
  requestConflictResolutions,
  describeResolution: (resolution: string) => resolution,
}));
vi.mock("../src/sync-executor", () => ({
  executeSyncPlan: execute,
  SyncExecutionError: class extends Error {},
}));

import { Notice } from "obsidian";
import VaultboxPlugin from "../src/main";
import {
  normalizePathKey,
  type LocalFileSnapshot,
  type SyncConflict,
  type SyncOperation,
  type SyncPlan,
} from "../src/sync-plan";
import type { DropboxFileMetadata, SyncedFileState } from "../src/types";

const REMOTE_TIME = "2026-01-01T12:00:00Z";

describe("sync conflict flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Notice as unknown as { messages: string[] }).messages = [];
    confirm.mockResolvedValue(true);
    execute.mockResolvedValue({ applied: 1, state: { files: {}, lastSyncedAt: 1 } });
  });

  function plugin(settings: Record<string, unknown> = {}) {
    const subject = new VaultboxPlugin(
      { vault: { configDir: ".obsidian", getFileByPath: () => null, getFolderByPath: () => null } } as never,
      {} as never,
    );
    Object.assign(subject, { manifest: { version: "1.1.0" }, debugLog: { write: vi.fn() } });
    Object.assign(subject.settings, { refreshToken: "token", selectedFolderPath: "/Vault" }, settings);
    vi.spyOn(subject, "saveSettings").mockResolvedValue();
    return subject;
  }

  function planFor(conflicts: SyncConflict[], operations: SyncOperation[] = []): SyncPlan {
    return {
      operations,
      conflicts,
      summary: {
        uploads: operations.filter((operation) => operation.kind === "upload").length,
        downloads: 0,
        remoteDeletes: 0,
        localDeletes: 0,
        noops: 0,
        conflicts: conflicts.length,
      },
    };
  }

  it("resolves a conflict and syncs the rest of the vault in one pass", async () => {
    const subject = plugin({ conflictPrompt: false });
    const conflict = bothModified("Notes/A.md", Date.parse("2026-01-01T12:30:00Z"));
    const otherUpload: SyncOperation = {
      kind: "upload",
      path: "Notes/B.md",
      local: local("Notes/B.md", "b-hash", 1),
    };
    vi.spyOn(subject, "buildSyncPlan").mockResolvedValue(planFor([conflict], [otherUpload]));

    await subject.syncNow();

    expect(requestConflictResolutions).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    const executed = execute.mock.calls[0][0].plan as SyncPlan;
    expect(executed.conflicts).toEqual([]);
    expect(executed.operations.map((operation) => `${operation.kind} ${operation.path}`)).toEqual([
      "upload Notes/B.md",
      "upload Notes/A.md",
    ]);
    expect(subject.settings.lastSyncSummary).toContain("Resolved 1 conflict");
  });

  it("asks before applying when review is switched on, and honours the answer", async () => {
    const subject = plugin();
    const conflict = bothModified("Notes/A.md", Date.parse("2026-01-01T12:30:00Z"));
    vi.spyOn(subject, "buildSyncPlan").mockResolvedValue(planFor([conflict]));
    requestConflictResolutions.mockResolvedValue(new Map([[conflict.path, "keep-remote"]]));

    await subject.syncNow();

    const request = requestConflictResolutions.mock.calls[0][1];
    expect(request.conflicts).toEqual([conflict]);
    expect(request.suggestions.get(conflict.path)).toBe("keep-local");
    const executed = execute.mock.calls[0][0].plan as SyncPlan;
    expect(executed.operations).toEqual([
      expect.objectContaining({ kind: "download", path: "Notes/A.md", overwriteLocal: true }),
    ]);
  });

  it("cancels the whole sync when the conflict list is dismissed", async () => {
    const subject = plugin();
    const conflict = bothModified("Notes/A.md", Date.parse("2026-01-01T12:30:00Z"));
    vi.spyOn(subject, "buildSyncPlan").mockResolvedValue(planFor([conflict]));
    requestConflictResolutions.mockResolvedValue(null);

    await subject.syncNow();

    expect(execute).not.toHaveBeenCalled();
    expect((Notice as unknown as { messages: string[] }).messages).toContain("Sync cancelled.");
  });

  it("leaves a skipped conflict for next time without blocking the rest", async () => {
    const subject = plugin();
    const conflict = bothModified("Notes/A.md", Date.parse("2026-01-01T12:30:00Z"));
    const otherUpload: SyncOperation = {
      kind: "upload",
      path: "Notes/B.md",
      local: local("Notes/B.md", "b-hash", 1),
    };
    vi.spyOn(subject, "buildSyncPlan").mockResolvedValue(planFor([conflict], [otherUpload]));
    requestConflictResolutions.mockResolvedValue(new Map([[conflict.path, "skip"]]));

    await subject.syncNow();

    const executed = execute.mock.calls[0][0].plan as SyncPlan;
    expect(executed.conflicts).toEqual([conflict]);
    expect(executed.operations).toEqual([otherUpload]);
    expect(subject.settings.lastSyncSummary).toContain("1 conflict left for later");
  });

  it("applies nothing when every conflict is skipped and there is no other work", async () => {
    const subject = plugin();
    const conflict = bothModified("Notes/A.md", Date.parse("2026-01-01T12:30:00Z"));
    vi.spyOn(subject, "buildSyncPlan").mockResolvedValue(planFor([conflict]));
    requestConflictResolutions.mockResolvedValue(new Map([[conflict.path, "skip"]]));

    await subject.syncNow();

    expect(execute).not.toHaveBeenCalled();
    expect(subject.settings.lastSyncSummary).toContain("1 conflict still need");
  });

  it("still blocks everything for a structural conflict", async () => {
    const subject = plugin();
    const blocking: SyncConflict = {
      kind: "conflict",
      type: "path-shape-conflict",
      path: "notes",
      message: "A file/folder path conflict blocks sync near notes.",
    };
    vi.spyOn(subject, "buildSyncPlan").mockResolvedValue(planFor([blocking], [{
      kind: "upload",
      path: "Notes/B.md",
      local: local("Notes/B.md", "b-hash", 1),
    }]));

    await subject.syncNow();

    expect(requestConflictResolutions).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(subject.settings.lastSyncSummary).toContain("Sync blocked");
  });

  it("leaves conflicts alone in ask mode when nobody can be asked", async () => {
    const subject = plugin({ conflictResolutionMode: "ask" });
    const conflict = bothModified("Notes/A.md", Date.parse("2026-01-01T12:30:00Z"));
    vi.spyOn(subject, "buildSyncPlan").mockResolvedValue(planFor([conflict]));

    await subject.syncNow({ interactive: false });

    expect(requestConflictResolutions).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(subject.settings.lastSyncSummary).toContain("still need a decision");
  });
});

function bothModified(path: string, localMtime: number): SyncConflict {
  return {
    kind: "conflict",
    type: "both-modified",
    path: normalizePathKey(path),
    message: `Local and Dropbox both changed ${path}.`,
    local: local(path, "local-hash", localMtime),
    remote: remote(path),
    previous: previous(path),
  };
}

function local(path: string, contentHash: string, mtime: number): LocalFileSnapshot {
  return { path, pathLower: normalizePathKey(path), contentHash, size: 10, mtime };
}

function remote(path: string): DropboxFileMetadata {
  return {
    tag: "file",
    name: path.split("/").pop() ?? path,
    pathDisplay: path,
    pathLower: normalizePathKey(path),
    id: `id:${path}`,
    clientModified: REMOTE_TIME,
    serverModified: REMOTE_TIME,
    rev: "rev-remote",
    size: 10,
    contentHash: "remote-hash",
  };
}

function previous(path: string): SyncedFileState {
  return {
    path,
    pathLower: normalizePathKey(path),
    localContentHash: "base-hash",
    remoteContentHash: "base-hash",
    remoteRev: "rev-base",
  };
}
