import { describe, expect, it, vi } from "vitest";

vi.mock("../src/settings-tab", () => ({ VaultboxSettingTab: class {} }));
vi.mock("../src/confirmation-modal", () => ({ requestConfirmation: vi.fn() }));
vi.mock("../src/sync-report-modal", () => ({ SyncReportModal: class {} }));

import VaultboxPlugin from "../src/main";

describe("bookmark settings persistence", () => {
  const configDir = ".custom-obsidian";
  const path = `${configDir}/bookmarks.json`;
  const bookmarkState = {
    path, pathLower: path, localContentHash: "hash", remoteContentHash: "hash", remoteRev: "rev",
  };

  function plugin(saved: unknown) {
    let stored = saved;
    const subject = new VaultboxPlugin({} as never, {} as never);
    Object.assign(subject, {
      app: { vault: { configDir } },
      loadData: vi.fn(async () => structuredClone(stored)),
      saveData: vi.fn(async (data: unknown) => { stored = structuredClone(data); }),
    });
    return subject;
  }

  it("keeps bookmarks off when upgrading an existing installation", async () => {
    const subject = plugin({ settings: { syncThemes: true } });
    await subject.loadSettings();
    expect(subject.settings.syncBookmarks).toBe(false);
    expect(subject.settings.syncThemes).toBe(true);
    expect(subject.getSyncPathPolicy().allowedConfigPaths).not.toContain(path);
  });

  it("persists the opt-in setting and preserves bookmark tracking across reloads", async () => {
    const subject = plugin({});
    await subject.loadSettings();
    subject.settings.syncBookmarks = true;
    subject.syncState = { files: { [path]: bookmarkState }, lastSyncedAt: 42 };
    await subject.saveSettings();
    subject.settings.syncBookmarks = false;
    subject.syncState = { files: {}, lastSyncedAt: 0 };
    await subject.loadSettings();
    expect(subject.settings.syncBookmarks).toBe(true);
    expect(subject.syncState.files[path]).toEqual(bookmarkState);
    expect(subject.getSyncPathPolicy().allowedConfigPaths).toContain(path);
  });

  it("persists removal of bookmark tracking when switched off without accessing vault files", async () => {
    const subject = plugin({
      settings: { syncBookmarks: true },
      syncState: { files: { [path]: bookmarkState }, lastSyncedAt: 42 },
    });
    await subject.loadSettings();
    subject.settings.syncBookmarks = false;
    await subject.saveSettings();
    await subject.loadSettings();
    expect(subject.settings.syncBookmarks).toBe(false);
    expect(subject.syncState).toEqual({ files: {}, lastSyncedAt: 42 });
    subject.settings.syncBookmarks = true;
    await subject.saveSettings();
    await subject.loadSettings();
    expect(subject.settings.syncBookmarks).toBe(true);
    expect(subject.syncState.files).toEqual({});
  });
});
