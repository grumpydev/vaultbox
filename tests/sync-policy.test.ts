import { describe, expect, it } from "vitest";
import {
  createSyncPathPolicy,
  filterSyncState,
  getValidExcludePatterns,
  getValidExtraHiddenDirs,
  isAdapterPath,
  isValidExtraHiddenDir,
  shouldSyncPath,
} from "../src/sync-policy";
import { DEFAULT_SETTINGS, type VaultboxSettings, type VaultboxSyncState } from "../src/types";

describe("sync path policy", () => {
  it("blocks configuration and hidden paths by default", () => {
    const policy = createSyncPathPolicy(DEFAULT_SETTINGS, ".custom-obsidian");

    expect(shouldSyncPath("Notes/A.md", policy)).toBe(true);
    expect(shouldSyncPath(".custom-obsidian/app.json", policy)).toBe(false);
    expect(shouldSyncPath(".obsidian/app.json", policy)).toBe(false);
    expect(shouldSyncPath(".git/config", policy)).toBe(false);
    expect(shouldSyncPath("Notes/.private/A.md", policy)).toBe(false);
    expect(shouldSyncPath("../outside.md", policy)).toBe(false);
  });

  it("allows only the enabled configuration categories", () => {
    const policy = createSyncPathPolicy(settings({
      syncCommunityPlugins: true,
      syncThemes: true,
    }), ".obsidian");

    expect(shouldSyncPath(".obsidian/community-plugins.json", policy)).toBe(true);
    expect(shouldSyncPath(".obsidian/themes/example/theme.css", policy)).toBe(true);
    expect(shouldSyncPath(".obsidian/snippets/example.css", policy)).toBe(false);
    expect(shouldSyncPath(".obsidian/workspace.json", policy)).toBe(false);
    expect(shouldSyncPath(".obsidian/plugins/vaultbox/data.json", policy)).toBe(false);
    expect(isAdapterPath(".obsidian/themes/example/theme.css", policy)).toBe(true);
  });

  it("allows validated extra hidden directories and applies exclusions", () => {
    const configured = settings({
      syncExtraHiddenDirs: [".claude", ".codex"],
      syncExcludePaths: [".claude/private", "secrets.json"],
    });
    const policy = createSyncPathPolicy(configured, ".obsidian");

    expect(shouldSyncPath(".claude/CLAUDE.md", policy)).toBe(true);
    expect(shouldSyncPath(".codex/skills/example.md", policy)).toBe(true);
    expect(shouldSyncPath(".claude/private/notes.md", policy)).toBe(false);
    expect(shouldSyncPath(".claude/secrets.json", policy)).toBe(false);
    expect(shouldSyncPath(".other/file.md", policy)).toBe(false);
  });

  it("sanitizes hidden directory names and exclusion patterns", () => {
    const configured = settings({
      syncExtraHiddenDirs: [".claude", ".CLAUDE", "..", ".git", ".obsidian", ".a/b", "visible"],
    });

    expect(isValidExtraHiddenDir(".codex", ".obsidian")).toBe(true);
    expect(isValidExtraHiddenDir("..", ".obsidian")).toBe(false);
    expect(getValidExtraHiddenDirs(configured, ".obsidian")).toEqual([".claude"]);
    expect(getValidExcludePatterns([" data.json ", "../outside", ".claude/private/", "DATA.JSON"])).toEqual([
      "data.json",
      ".claude/private",
    ]);
    expect(getValidExtraHiddenDirs({
      ...DEFAULT_SETTINGS,
      syncExtraHiddenDirs: ".." as never,
    }, ".obsidian")).toEqual([]);
    expect(getValidExcludePatterns("data.json")).toEqual([]);
  });

  it("drops excluded paths from persisted sync state without creating delete work", () => {
    const policy = createSyncPathPolicy(DEFAULT_SETTINGS, ".obsidian");
    const state: VaultboxSyncState = {
      files: {
        "notes/a.md": synced("Notes/A.md"),
        ".obsidian/app.json": synced(".obsidian/app.json"),
        ".claude/claude.md": synced(".claude/CLAUDE.md"),
      },
      lastSyncedAt: 42,
    };

    expect(Object.keys(filterSyncState(state, policy).files)).toEqual(["notes/a.md"]);
  });
});

function settings(overrides: Partial<VaultboxSettings>): VaultboxSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

function synced(path: string) {
  return {
    path,
    pathLower: path.toLowerCase(),
    localContentHash: "hash",
    remoteContentHash: "hash",
    remoteRev: "rev",
  };
}
