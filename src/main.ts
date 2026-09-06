import { addIcon, Notice, Plugin } from "obsidian";
import {
  createDropboxAuthSession,
  exchangeDropboxAuthCode,
  refreshDropboxAccessToken,
} from "./dropbox-auth";
import { requestConfirmation } from "./confirmation-modal";
import { DROPBOX_APP_KEY } from "./constants";
import { DebugLog, type DebugLogEntry } from "./debug-log";
import { DropboxClient, normalizeDropboxPath } from "./dropbox";
import { VAULTBOX_ICON_PATHS } from "./icons";
import { VaultboxSettingTab } from "./settings-tab";
import { executeSyncPlan, SyncExecutionError } from "./sync-executor";
import { createSyncPathPolicy, filterSyncState, type SyncPathPolicy } from "./sync-policy";
import {
  createRemoteFileSnapshot,
  createSyncPlan,
  formatSyncPlan,
  getMutationPathDiagnostics,
  isPlanEmpty,
  scanLocalVault,
  type SyncPlan,
} from "./sync-plan";
import { DEFAULT_SETTINGS, type VaultboxSettings, type VaultboxSyncState } from "./types";

interface VaultboxPluginData {
  settings?: Partial<VaultboxSettings> & { dropboxAppKey?: string };
  pendingAuthCodeVerifier?: string;
  syncState?: VaultboxSyncState;
  debugLog?: DebugLogEntry[];
}

export default class VaultboxPlugin extends Plugin {
  settings: VaultboxSettings = { ...DEFAULT_SETTINGS };
  pendingAuthCodeVerifier = "";
  syncState: VaultboxSyncState = { files: {}, lastSyncedAt: 0 };
  private ribbonIconEl: HTMLElement | null = null;
  private debugLog!: DebugLog;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.debugLog = new DebugLog(this.settings, async (entries) => {
      await this.savePluginData({ debugLog: entries });
    });
    this.debugLog.load((await this.loadPluginData()).debugLog);

    addIcon("vaultbox-logo", VAULTBOX_ICON_PATHS);
    this.ribbonIconEl = this.addRibbonIcon("vaultbox-logo", "Sync with Vaultbox", () => {
      void this.syncNow();
    });
    this.ribbonIconEl.classList.add("vaultbox-ribbon-icon");
    this.keepRibbonIconAtEnd();
    this.app.workspace.onLayoutReady(() => {
      this.keepRibbonIconAtEnd();
      window.setTimeout(() => this.keepRibbonIconAtEnd(), 250);
      window.setTimeout(() => this.keepRibbonIconAtEnd(), 1_500);
    });

    this.addCommand({
      id: "connect-dropbox",
      name: "Connect Dropbox",
      callback: () => {
        void this.startDropboxAuth();
      },
    });

    this.addCommand({
      id: "validate-dropbox-folder",
      name: "Validate Dropbox folder",
      callback: () => {
        void this.validateSelectedFolder();
      },
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync with Dropbox",
      callback: () => {
        void this.syncNow();
      },
    });

    this.addSettingTab(new VaultboxSettingTab(this.app, this));
  }

  keepRibbonIconAtEnd(): void {
    this.ribbonIconEl?.parentElement?.appendChild(this.ribbonIconEl);
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadPluginData();
    const savedSettings = data.settings;
    const { dropboxAppKey: _dropboxAppKey, ...settings } = savedSettings ?? {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...settings,
    };
    const policy = this.getSyncPathPolicy();
    this.settings.syncExtraHiddenDirs = policy.extraHiddenDirs;
    this.settings.syncExcludePaths = policy.excludePatterns;
    this.pendingAuthCodeVerifier = data?.pendingAuthCodeVerifier ?? "";
    this.syncState = filterSyncState(
      data?.syncState ?? { files: {}, lastSyncedAt: 0 },
      policy,
    );
  }

  async saveSettings(): Promise<void> {
    const policy = this.getSyncPathPolicy();
    this.settings.syncExtraHiddenDirs = policy.extraHiddenDirs;
    this.settings.syncExcludePaths = policy.excludePatterns;
    this.syncState = filterSyncState(this.syncState, policy);
    await this.savePluginData({
      settings: this.settings,
      pendingAuthCodeVerifier: this.pendingAuthCodeVerifier,
      syncState: this.syncState,
    });
  }

  async savePluginData(patch: Partial<VaultboxPluginData>): Promise<void> {
    const current = await this.loadPluginData();
    await this.saveData({
      ...current,
      ...patch,
    } satisfies VaultboxPluginData);
  }

  async loadPluginData(): Promise<VaultboxPluginData> {
    const data: unknown = await this.loadData();

    if (!data || typeof data !== "object") {
      return {};
    }

    return data;
  }

  getDebugLogText(): string {
    return this.debugLog.format();
  }

  getDebugLogCount(): number {
    return this.debugLog.getEntries().length;
  }

  async clearDebugLog(): Promise<void> {
    await this.debugLog.clear();
  }

  async resetSyncState(): Promise<void> {
    this.syncState = { files: {}, lastSyncedAt: 0 };
    this.settings.lastSyncStartedAt = null;
    this.settings.lastSyncCompletedAt = null;
    this.settings.lastSyncSummary = "Sync tracking reset. The next sync will compare local files and Dropbox as a fresh setup.";
    this.debugLog.write("sync-state.reset");
    await this.saveSettings();
  }

  isConnected(): boolean {
    return Boolean(this.settings.refreshToken);
  }

  async startDropboxAuth(): Promise<void> {
    const session = await createDropboxAuthSession(DROPBOX_APP_KEY);
    this.pendingAuthCodeVerifier = session.codeVerifier;
    await this.saveSettings();
    window.open(session.authUrl);
    new Notice("Dropbox opened. Approve Vaultbox, then paste the authorization code here.");
  }

  async finishDropboxAuth(code: string): Promise<void> {
    if (!this.pendingAuthCodeVerifier) {
      throw new Error("Start Dropbox auth before entering a code.");
    }

    const tokens = await exchangeDropboxAuthCode({
      appKey: DROPBOX_APP_KEY,
      code,
      codeVerifier: this.pendingAuthCodeVerifier,
    });

    this.settings.accessToken = tokens.accessToken;
    this.settings.accessTokenExpiresAt = tokens.accessTokenExpiresAt;
    this.settings.refreshToken = tokens.refreshToken;
    this.pendingAuthCodeVerifier = "";
    await this.saveSettings();
    new Notice("Dropbox connected.");
  }

  async getAccessToken(): Promise<string> {
    if (!this.settings.refreshToken) {
      throw new Error("Dropbox is not connected.");
    }

    if (this.settings.accessToken && Date.now() < this.settings.accessTokenExpiresAt) {
      return this.settings.accessToken;
    }

    const refreshed = await refreshDropboxAccessToken({
      appKey: DROPBOX_APP_KEY,
      refreshToken: this.settings.refreshToken,
    });
    this.settings.accessToken = refreshed.accessToken;
    this.settings.accessTokenExpiresAt = refreshed.accessTokenExpiresAt;
    await this.saveSettings();
    return refreshed.accessToken;
  }

  createDropboxClient(): DropboxClient {
    return new DropboxClient({
      getAccessToken: () => this.getAccessToken(),
    });
  }

  getSyncPathPolicy(): SyncPathPolicy {
    return createSyncPathPolicy(this.settings, this.app.vault.configDir);
  }

  async validateSelectedFolder(): Promise<void> {
    const folderPath = normalizeDropboxPath(this.settings.selectedFolderPath);
    if (!folderPath) {
      new Notice("Choose a Dropbox folder before validating. The Dropbox root cannot be used.");
      return;
    }

    this.settings.selectedFolderPath = folderPath;
    await this.saveSettings();

    if (!this.isConnected()) {
      new Notice("Connect Dropbox before validating a folder.");
      return;
    }

    const metadata = await this.createDropboxClient().getMetadata(folderPath);
    if (metadata.tag !== "folder") {
      throw new Error(`${folderPath || "/"} is not a Dropbox folder.`);
    }

    new Notice(`Vaultbox folder validated: ${metadata.pathDisplay || "/"}`);
  }

  async syncNow(): Promise<void> {
    const hadExistingSyncState = Object.keys(this.syncState.files).length > 0;
    let progressNotice: Notice | null = null;

    try {
      this.debugLog.write("sync.start", {
        version: this.manifest.version,
        folderPath: this.settings.selectedFolderPath,
        confirm: this.settings.syncMode === "manual" && this.settings.confirmBeforeManualSync,
      });
      this.settings.lastSyncStartedAt = Date.now();
      progressNotice = new Notice("Vaultbox: preparing sync plan...", 0);
      const plan = await this.buildSyncPlan();
      this.writeMutationPathDiagnostics("sync.plan-paths", plan);
      if (plan.conflicts.length > 0) {
        const message = formatSyncPlan(plan, "Sync blocked");
        this.settings.lastSyncSummary = message;
        this.debugLog.write("sync.conflicts", plan.summary);
        await this.saveSettings();
        progressNotice.hide();
        new Notice(message);
        return;
      }

      if (isPlanEmpty(plan)) {
        this.settings.lastSyncCompletedAt = Date.now();
        this.settings.lastSyncSummary = "No sync required. Everything is up to date.";
        this.debugLog.write("sync.noop", plan.summary);
        await this.saveSettings();
        progressNotice.hide();
        new Notice("No sync required. Everything is up to date.");
        return;
      }

      if (this.settings.syncMode === "manual" && this.settings.confirmBeforeManualSync) {
        progressNotice.hide();
        progressNotice = null;
        const confirmed = await requestConfirmation(this.app, {
          title: "Confirm sync",
          message: `${formatSyncPlan(plan, "Planned changes")}\n\nApply these changes now?`,
          confirmText: "Sync now",
        });
        if (!confirmed) {
          new Notice("Sync cancelled.");
          return;
        }
      }

      const totalChanges = getPlanChangeCount(plan);
      if (progressNotice) {
        progressNotice.setMessage(`Vaultbox syncing: 0/${totalChanges} changes`);
      } else {
        progressNotice = new Notice(`Vaultbox syncing: 0/${totalChanges} changes`, 0);
      }
      const result = await executeSyncPlan({
        vault: this.app.vault,
        fileManager: this.app.fileManager,
        dropbox: this.createDropboxClient(),
        rootPath: normalizeDropboxPath(this.settings.selectedFolderPath),
        pathPolicy: this.getSyncPathPolicy(),
        plan,
        currentState: this.syncState,
        onProgress: (progress) => {
          progressNotice?.setMessage(formatSyncProgress(progress));
        },
      });
      this.syncState = result.state;
      this.settings.lastSyncCompletedAt = Date.now();
      this.settings.lastSyncSummary = `Sync complete. Applied ${result.applied} change${result.applied === 1 ? "" : "s"}.`;
      this.debugLog.write("sync.complete", {
        applied: result.applied,
        summary: plan.summary,
      });
      await this.saveSettings();
      progressNotice.hide();
      new Notice(this.settings.lastSyncSummary);
    } catch (error) {
      if (error instanceof SyncExecutionError && hadExistingSyncState) {
        this.syncState = error.partialState;
        await this.saveSettings();
      }
      const message = error instanceof Error ? error.message : String(error);
      this.settings.lastSyncSummary = `Failed: ${message}`;
      this.debugLog.write("sync.failed", { message });
      await this.saveSettings();
      progressNotice?.hide();
      new Notice(message);
    }
  }

  async simulateSync(): Promise<void> {
    try {
      this.debugLog.write("simulation.start", {
        version: this.manifest.version,
        folderPath: this.settings.selectedFolderPath,
      });
      const plan = await this.buildSyncPlan();
      this.writeMutationPathDiagnostics("simulation.plan-paths", plan);
      const message = formatSyncPlan(plan);
      this.settings.lastSyncCompletedAt = Date.now();
      this.settings.lastSyncSummary = message;
      this.debugLog.write("simulation.complete", plan.summary);
      await this.saveSettings();
      new Notice("Simulation complete.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settings.lastSyncSummary = `Simulation failed: ${message}`;
      this.debugLog.write("simulation.failed", { message });
      await this.saveSettings();
      new Notice(this.settings.lastSyncSummary);
    }
  }

  async buildSyncPlan(): Promise<SyncPlan> {
    if (!this.isConnected()) {
      throw new Error("Connect Dropbox before syncing.");
    }

    const folderPath = normalizeDropboxPath(this.settings.selectedFolderPath);
    if (!folderPath) {
      throw new Error("Choose a Dropbox folder before syncing. The Dropbox root cannot be used.");
    }

    this.settings.selectedFolderPath = folderPath;
    await this.saveSettings();
    const pathPolicy = this.getSyncPathPolicy();

    const [localFiles, remoteFiles] = await Promise.all([
      scanLocalVault(this.app.vault, pathPolicy),
      this.createDropboxClient().listAllFiles(folderPath),
    ]);

    return createSyncPlan({
      localFiles,
      remoteFiles: createRemoteFileSnapshot(remoteFiles, folderPath, pathPolicy),
      state: filterSyncState(this.syncState, pathPolicy),
    });
  }

  private writeMutationPathDiagnostics(message: string, plan: SyncPlan): void {
    const diagnostics = getMutationPathDiagnostics(plan);
    if (diagnostics.total > 0) {
      this.debugLog.write(message, diagnostics);
    }
  }
}

function getPlanChangeCount(plan: SyncPlan): number {
  return plan.summary.uploads + plan.summary.downloads + plan.summary.remoteDeletes + plan.summary.localDeletes;
}

function formatSyncProgress(progress: {
  completed: number;
  total: number;
  operation: string;
  path: string;
}): string {
  return [
    `Vaultbox syncing: ${progress.completed}/${progress.total} changes`,
    `${formatOperationLabel(progress.operation)} ${truncatePath(progress.path)}`,
  ].join("\n");
}

function formatOperationLabel(operation: string): string {
  switch (operation) {
    case "upload":
      return "Uploading";
    case "download":
      return "Downloading";
    case "delete-remote":
      return "Deleting from Dropbox";
    case "delete-local":
      return "Deleting locally";
    default:
      return "Syncing";
  }
}

function truncatePath(path: string): string {
  const maxLength = 72;
  if (path.length <= maxLength) {
    return path;
  }

  return `...${path.slice(path.length - maxLength + 3)}`;
}
