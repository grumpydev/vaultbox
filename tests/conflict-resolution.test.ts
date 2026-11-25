import { describe, expect, it } from "vitest";
import {
  applyResolutions,
  buildConflictCopyPath,
  chooseAutoResolution,
  conflictLocalPath,
  resolutionToOperations,
  type ConflictPolicy,
} from "../src/conflict-resolution";
import {
  createSyncPlan,
  normalizePathKey,
  type LocalFileSnapshot,
  type SyncConflict,
  type SyncPlan,
} from "../src/sync-plan";
import type { DropboxFileMetadata, SyncedFileState } from "../src/types";

const REMOTE_TIME = "2026-01-01T12:00:00Z";
const LOCAL_NEWER = Date.parse("2026-01-01T12:10:00Z");
const LOCAL_OLDER = Date.parse("2026-01-01T11:50:00Z");
const LOCAL_SIMULTANEOUS = Date.parse("2026-01-01T12:00:30Z");

function policy(overrides: Partial<ConflictPolicy> = {}): ConflictPolicy {
  return {
    mode: "newest-wins",
    ambiguityWindowSeconds: 60,
    canCreateConflictCopy: () => true,
    ...overrides,
  };
}

describe("conflict policy", () => {
  it("keeps the side that was edited more recently", () => {
    expect(chooseAutoResolution(bothModified("Notes/A.md", LOCAL_NEWER), policy())).toBe("keep-local");
    expect(chooseAutoResolution(bothModified("Notes/A.md", LOCAL_OLDER), policy())).toBe("keep-remote");
  });

  it("keeps both copies when the two edits are too close together to call", () => {
    expect(chooseAutoResolution(bothModified("Notes/A.md", LOCAL_SIMULTANEOUS), policy())).toBe("keep-both");
  });

  it("respects a widened safety window", () => {
    const conflict = bothModified("Notes/A.md", LOCAL_NEWER);
    expect(chooseAutoResolution(conflict, policy({ ambiguityWindowSeconds: 3600 }))).toBe("keep-both");
  });

  it("keeps both copies of an attachment rather than guessing which is newer", () => {
    expect(chooseAutoResolution(bothModified("Files/diagram.png", LOCAL_NEWER), policy())).toBe("keep-both");
  });

  it("never lets a delete beat an edit", () => {
    for (const mode of ["newest-wins", "keep-both", "ask"] as const) {
      expect(chooseAutoResolution(localEditRemoteDelete("Notes/A.md"), policy({ mode }))).toBe("keep-local");
      expect(chooseAutoResolution(localDeleteRemoteEdit("Notes/A.md"), policy({ mode }))).toBe("keep-remote");
    }
  });

  it("falls back to the newer file where a conflict copy cannot be created", () => {
    const noCopies = policy({ canCreateConflictCopy: () => false });
    expect(chooseAutoResolution(bothModified("Files/diagram.png", LOCAL_NEWER), noCopies)).toBe("keep-local");
    expect(chooseAutoResolution(bothModified("Files/diagram.png", LOCAL_SIMULTANEOUS), noCopies)).toBe("skip");
  });

  it("leaves everything for the user in ask mode", () => {
    expect(chooseAutoResolution(bothModified("Notes/A.md", LOCAL_NEWER), policy({ mode: "ask" }))).toBe("keep-both");
    expect(chooseAutoResolution(
      bothModified("Notes/A.md", LOCAL_NEWER),
      policy({ mode: "ask", canCreateConflictCopy: () => false }),
    )).toBe("skip");
  });

  it("treats first-sync divergence like any other two-sided edit", () => {
    const conflict = { ...bothModified("Notes/A.md", LOCAL_NEWER), type: "both-new" as const, previous: undefined };
    expect(chooseAutoResolution(conflict, policy())).toBe("keep-local");
  });
});

describe("conflict copy paths", () => {
  it("names the copy after the Dropbox revision time", () => {
    const copy = buildConflictCopyPath("Notes/A.md", "2026-11-25T12:00:00Z");
    expect(copy).toMatch(/^Notes\/A \(Dropbox conflict \d{4}-\d{2}-\d{2} \d{2}-\d{2}\)\.md$/);
  });

  it("keeps extensionless and nested names intact", () => {
    expect(buildConflictCopyPath("LICENSE", REMOTE_TIME)).toContain("LICENSE (Dropbox conflict");
    expect(buildConflictCopyPath("LICENSE", REMOTE_TIME)).not.toContain(".");
    expect(buildConflictCopyPath("a/b/c.canvas", REMOTE_TIME).startsWith("a/b/c (")).toBe(true);
  });

  it("steps aside when the name is already taken", () => {
    const first = buildConflictCopyPath("Notes/A.md", REMOTE_TIME);
    const second = buildConflictCopyPath("Notes/A.md", REMOTE_TIME, (candidate) => candidate === first);
    expect(second).toBe(first.replace(/\)\.md$/, ") 2.md"));
  });
});

describe("resolutions to operations", () => {
  it("pushes the local file over Dropbox for keep-local", () => {
    const conflict = bothModified("Notes/A.md", LOCAL_NEWER);
    expect(resolutionToOperations(conflict, "keep-local")).toEqual([
      expect.objectContaining({ kind: "upload", path: "Notes/A.md", overwriteRemote: true }),
    ]);
  });

  it("replaces the local file for keep-remote and trashes what it replaced", () => {
    const conflict = bothModified("Notes/A.md", LOCAL_NEWER);
    expect(resolutionToOperations(conflict, "keep-remote", { trashOverwrittenLocal: true })).toEqual([
      expect.objectContaining({
        kind: "download",
        path: "Notes/A.md",
        overwriteLocal: true,
        trashExistingLocal: true,
      }),
    ]);
  });

  it("writes the Dropbox copy beside the local file for keep-both", () => {
    const conflict = bothModified("Notes/A.md", LOCAL_NEWER);
    const operations = resolutionToOperations(conflict, "keep-both", { conflictCopyPath: "Notes/A (copy).md" });

    expect(operations).toEqual([
      expect.objectContaining({ kind: "download", path: "Notes/A.md", targetPath: "Notes/A (copy).md" }),
      expect.objectContaining({ kind: "upload", path: "Notes/A.md", overwriteRemote: true }),
    ]);
    // The copy must not claim the previous sync state, or it would download over itself.
    expect(operations[0]).not.toHaveProperty("previous", expect.anything());
  });

  it("refuses keep-both without a copy path instead of guessing", () => {
    expect(resolutionToOperations(bothModified("Notes/A.md", LOCAL_NEWER), "keep-both")).toEqual([]);
  });

  it("applies a deletion only when that side is chosen explicitly", () => {
    expect(resolutionToOperations(localEditRemoteDelete("Notes/A.md"), "keep-remote")).toEqual([
      expect.objectContaining({ kind: "delete-local", force: true }),
    ]);
    expect(resolutionToOperations(localEditRemoteDelete("Notes/A.md"), "keep-both")).toEqual([
      expect.objectContaining({ kind: "upload", overwriteRemote: true }),
    ]);
    expect(resolutionToOperations(localDeleteRemoteEdit("Notes/A.md"), "keep-local")).toEqual([
      expect.objectContaining({ kind: "delete-remote", force: true }),
    ]);
    expect(resolutionToOperations(localDeleteRemoteEdit("Notes/A.md"), "keep-both")).toEqual([
      expect.objectContaining({ kind: "download", overwriteLocal: true }),
    ]);
  });

  it("produces nothing for skip", () => {
    expect(resolutionToOperations(bothModified("Notes/A.md", LOCAL_NEWER), "skip")).toEqual([]);
  });
});

describe("applying resolutions to a plan", () => {
  it("turns decisions into operations and leaves skipped files conflicted", () => {
    const resolvedConflict = bothModified("Notes/A.md", LOCAL_NEWER);
    const skippedConflict = bothModified("Notes/B.md", LOCAL_NEWER);
    const base = planWith([resolvedConflict, skippedConflict]);

    const outcome = applyResolutions(
      base,
      new Map([[resolvedConflict.path, "keep-local"], [skippedConflict.path, "skip"]]),
      () => undefined,
    );

    expect(outcome.resolved).toBe(1);
    expect(outcome.skipped).toBe(1);
    expect(outcome.plan.operations.map((operation) => operation.kind)).toEqual(["upload"]);
    expect(outcome.plan.conflicts).toEqual([skippedConflict]);
    expect(outcome.plan.summary).toMatchObject({ uploads: 1, conflicts: 1 });
  });

  it("keeps a file conflicted when its copy path cannot be created", () => {
    const conflict = bothModified("Notes/A.md", LOCAL_NEWER);
    const outcome = applyResolutions(planWith([conflict]), new Map([[conflict.path, "keep-both"]]), () => undefined);

    expect(outcome.resolved).toBe(0);
    expect(outcome.plan.conflicts).toEqual([conflict]);
  });

  it("gives each conflict copy a free path", () => {
    const first = bothModified("Notes/A.md", LOCAL_NEWER);
    const second = { ...bothModified("Notes/A.md", LOCAL_NEWER), path: "notes/a2.md" };
    const taken: string[] = [];

    const outcome = applyResolutions(
      planWith([first, second]),
      new Map([[first.path, "keep-both"], [second.path, "keep-both"]]),
      (conflict, isTaken) => {
        const copy = buildConflictCopyPath(conflictLocalPath(conflict), REMOTE_TIME, isTaken);
        taken.push(copy);
        return copy;
      },
    );

    expect(outcome.resolved).toBe(2);
    expect(new Set(taken).size).toBe(2);
  });

  it("leaves structural conflicts untouched", () => {
    const structural: SyncConflict = {
      kind: "conflict",
      type: "path-shape-conflict",
      path: "notes",
      message: "blocked",
    };
    const outcome = applyResolutions(planWith([structural]), new Map([["notes", "keep-local"]]), () => undefined);

    expect(outcome.resolved).toBe(0);
    expect(outcome.plan.conflicts).toEqual([structural]);
  });
});

function planWith(conflicts: SyncConflict[]): SyncPlan {
  const plan = createSyncPlan({ localFiles: new Map(), remoteFiles: new Map() });
  return {
    ...plan,
    conflicts,
    summary: { ...plan.summary, conflicts: conflicts.length },
  };
}

function bothModified(path: string, localMtime: number): SyncConflict {
  return {
    kind: "conflict",
    type: "both-modified",
    path: normalizePathKey(path),
    message: `Local and Dropbox both changed ${path}.`,
    local: local(path, "local-hash", localMtime),
    remote: remote(path, "remote-hash"),
    previous: previous(path),
  };
}

function localEditRemoteDelete(path: string): SyncConflict {
  return {
    kind: "conflict",
    type: "local-edit-remote-delete",
    path: normalizePathKey(path),
    message: `Local changed ${path}, but Dropbox deleted it.`,
    local: local(path, "local-hash", LOCAL_NEWER),
    previous: previous(path),
  };
}

function localDeleteRemoteEdit(path: string): SyncConflict {
  return {
    kind: "conflict",
    type: "local-delete-remote-edit",
    path: normalizePathKey(path),
    message: `Local deleted ${path}, but Dropbox changed it too.`,
    remote: remote(path, "remote-hash"),
    previous: previous(path),
  };
}

function local(path: string, contentHash: string, mtime: number): LocalFileSnapshot {
  return { path, pathLower: normalizePathKey(path), contentHash, size: 10, mtime };
}

function remote(path: string, contentHash: string): DropboxFileMetadata {
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
    contentHash,
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
