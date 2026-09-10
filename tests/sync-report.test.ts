import { describe, expect, it } from "vitest";
import { createSyncPlan, formatSyncPlan, type LocalFileSnapshot } from "../src/sync-plan";
import { formatCompleteSyncReport } from "../src/sync-report";
import type { DropboxFileMetadata, SyncedFileState } from "../src/types";

const context = { version: "1.0.10", folderPath: "/Test vault", createdAt: "2026-09-10T08:00:00Z" };

function local(path: string): LocalFileSnapshot {
  return { path, pathLower: path.toLowerCase(), contentHash: "private-hash", size: 1, mtime: 1 };
}

function remote(path: string): DropboxFileMetadata {
  return {
    tag: "file", name: path, pathDisplay: path, pathLower: path.toLowerCase(),
    contentHash: "private-hash", id: "private-id", rev: "private-revision", size: 1,
    clientModified: "", serverModified: "",
  };
}

function previous(path: string): SyncedFileState {
  return {
    path, pathLower: path.toLowerCase(), localContentHash: "private-hash",
    remoteContentHash: "private-hash", remoteRev: "private-revision",
  };
}

export function reporterPlan() {
  const downloads = Array.from({ length: 184 }, (_, i) => remote(`Downloads/${i}.md`));
  const deletes = Array.from({ length: 22 }, (_, i) => local(`Deleted/${i}.md`));
  const unchanged = Array.from({ length: 2000 }, (_, i) => local(`Unchanged/${i}.md`));
  return createSyncPlan({
    localFiles: new Map([...deletes, ...unchanged].map((file) => [file.pathLower, file])),
    remoteFiles: new Map([...downloads, ...unchanged.map((file) => remote(file.path))]
      .map((file) => [file.pathLower, file])),
    state: {
      files: Object.fromEntries(deletes.map((file) => [file.pathLower, previous(file.path)])),
      lastSyncedAt: 1,
    },
  });
}

describe("complete simulation report", () => {
  it("includes every operation in the reporter's 184-download/22-delete plan", () => {
    const plan = reporterPlan();
    const before = structuredClone(plan);
    const report = formatCompleteSyncReport(plan, context);
    expect(plan.summary).toEqual({ uploads: 0, downloads: 184, remoteDeletes: 0, localDeletes: 22, noops: 2000, conflicts: 0 });
    expect(report).toContain("Local deletes (22)");
    expect(report.indexOf("Local deletes (22)")).toBeLessThan(report.indexOf("Downloads (184)"));
    const paths = report.split("\n").filter((line) => line.startsWith("- ")).map((line) => JSON.parse(line.slice(2)));
    expect(paths).toHaveLength(2206);
    expect(new Set(paths)).toEqual(new Set(plan.operations.map((operation) => operation.path)));
    expect(report).not.toContain("not shown");
    expect(report).not.toContain("private-hash");
    expect(report).not.toContain("private-revision");
    expect(plan).toEqual(before);
    expect(formatSyncPlan(plan)).toContain("194 more planned changes not shown.");
  });

  it("includes uploads, remote deletes, and all conflicts beyond preview limits", () => {
    const conflicts = Array.from({ length: 25 }, (_, i) => `Conflicts/${i}.md`);
    const plan = createSyncPlan({
      localFiles: new Map([local("Upload.md"), ...conflicts.map(local)].map((file) => [file.pathLower, file])),
      remoteFiles: new Map([remote("Delete.md"), ...conflicts.map((path) => ({ ...remote(path), contentHash: "changed" }))]
        .map((file) => [file.pathLower, file])),
      state: { files: { "delete.md": previous("Delete.md") }, lastSyncedAt: 1 },
    });
    const report = formatCompleteSyncReport(plan, context);
    expect(report).toContain('Remote deletes (1)\n- "Delete.md"');
    expect(report).toContain('Uploads (1)\n- "Upload.md"');
    expect(report).toContain("Conflicts (25)");
    for (const path of conflicts) expect(report).toContain(JSON.stringify(path.toLowerCase()));
    expect(formatSyncPlan(plan)).toContain("13 more planned changes not shown.");
  });

  it("preserves long Unicode paths and safely quotes control characters", () => {
    const path = `Folder/${"long-".repeat(100)}\u202fAM\n<note>.md`;
    const plan = createSyncPlan({ localFiles: new Map(), remoteFiles: new Map() });
    plan.operations.push({ kind: "upload", path, local: local(path) });
    const report = formatCompleteSyncReport(plan, context);
    expect(report).toContain(`- ${JSON.stringify(path)}`);
    expect(report.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
  });

  it("labels empty reports as unapplied snapshots with context and zero counts", () => {
    const report = formatCompleteSyncReport(createSyncPlan({ localFiles: new Map(), remoteFiles: new Map() }), context);
    expect(report).toContain("Simulation snapshot (not applied)");
    expect(report).toContain(`Version: ${context.version}`);
    expect(report).toContain(context.createdAt);
    expect(report).toContain('Dropbox folder: "/Test vault"');
    expect(report).toContain("Local deletes (0)");
    expect(report).toContain("Conflicts (0)");
  });
});
