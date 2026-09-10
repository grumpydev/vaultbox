import { beforeEach, describe, expect, it, vi } from "vitest";

const { open, reports, execute } = vi.hoisted(() => ({ open: vi.fn(), reports: [] as string[], execute: vi.fn() }));
vi.mock("../src/settings-tab", () => ({ VaultboxSettingTab: class {} }));
vi.mock("../src/confirmation-modal", () => ({ requestConfirmation: vi.fn() }));
vi.mock("../src/sync-executor", () => ({ executeSyncPlan: execute, SyncExecutionError: class extends Error {} }));
vi.mock("../src/sync-report-modal", () => ({
  SyncReportModal: class {
    constructor(_app: unknown, report: string) { reports.push(report); }
    open = open;
  },
}));

import VaultboxPlugin from "../src/main";
import { createSyncPlan } from "../src/sync-plan";

describe("simulation report lifecycle", () => {
  beforeEach(() => { reports.length = 0; vi.clearAllMocks(); });

  function plugin() {
    const plugin = new VaultboxPlugin({} as never, {} as never);
    Object.assign(plugin, { manifest: { version: "1.0.10" }, debugLog: { write: vi.fn() } });
    vi.spyOn(plugin, "saveSettings").mockResolvedValue();
    vi.spyOn(plugin, "buildSyncPlan").mockResolvedValue(createSyncPlan({ localFiles: new Map(), remoteFiles: new Map() }));
    return plugin;
  }

  it("opens and reopens the same report without executing a sync or changing tracking", async () => {
    const subject = plugin();
    const tracking = subject.syncState;
    expect(subject.hasSimulationReport()).toBe(false);
    await subject.simulateSync();
    expect(subject.hasSimulationReport()).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(reports[0]).toContain("Simulation snapshot (not applied)");
    subject.showSimulationReport();
    expect(reports[1]).toEqual(reports[0]);
    expect(subject.buildSyncPlan).toHaveBeenCalledTimes(1);
    expect(subject.syncState).toBe(tracking);
    expect(execute).not.toHaveBeenCalled();
  });

  it("clears an old report when the next scan fails", async () => {
    const subject = plugin();
    await subject.simulateSync();
    vi.mocked(subject.buildSyncPlan).mockRejectedValueOnce(new Error("Offline"));
    await subject.simulateSync();
    expect(subject.hasSimulationReport()).toBe(false);
    subject.showSimulationReport();
    expect(open).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("clears the report when tracking is reset", async () => {
    const subject = plugin();
    await subject.simulateSync();
    await subject.resetSyncState();
    expect(subject.hasSimulationReport()).toBe(false);
  });
});
