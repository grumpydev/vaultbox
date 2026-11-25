import { App, Modal, Setting, type DropdownComponent } from "obsidian";
import { conflictLocalPath, type ConflictResolution } from "./conflict-resolution";
import type { SyncConflict } from "./sync-plan";

const MAX_RENDERED_ROWS = 50;

export interface ConflictDecisionRequest {
  conflicts: SyncConflict[];
  /** Resolution Vaultbox proposes per conflict path, from the configured policy. */
  suggestions: Map<string, ConflictResolution>;
  /** False where a conflict copy cannot be created, e.g. inside the config directory. */
  allowKeepBoth: (conflict: SyncConflict) => boolean;
}

export function requestConflictResolutions(
  app: App,
  request: ConflictDecisionRequest,
): Promise<Map<string, ConflictResolution> | null> {
  return new Promise((resolve) => {
    new ConflictResolutionModal(app, request, resolve).open();
  });
}

/** Keeps a choice meaningful for conflicts that cannot honour it literally. */
export function normalizeResolution(
  conflict: SyncConflict,
  resolution: ConflictResolution,
  allowKeepBoth: boolean,
): ConflictResolution {
  if (resolution !== "keep-both") {
    return resolution;
  }

  if (conflict.type === "local-edit-remote-delete") {
    return "keep-local";
  }

  if (conflict.type === "local-delete-remote-edit") {
    return "keep-remote";
  }

  return allowKeepBoth ? "keep-both" : "skip";
}

export function describeConflictChoices(
  conflict: SyncConflict,
  allowKeepBoth: boolean,
): Record<string, string> {
  if (conflict.type === "local-edit-remote-delete") {
    return {
      "keep-local": "Restore my file to Dropbox",
      "keep-remote": "Accept the deletion",
      skip: "Decide later",
    };
  }

  if (conflict.type === "local-delete-remote-edit") {
    return {
      "keep-remote": "Restore the file from Dropbox",
      "keep-local": "Confirm my deletion",
      skip: "Decide later",
    };
  }

  return {
    ...(allowKeepBoth ? { "keep-both": "Keep both" } : {}),
    "keep-local": "Keep this device",
    "keep-remote": "Keep Dropbox",
    skip: "Decide later",
  };
}

export function describeConflictSides(conflict: SyncConflict): string {
  const local = conflict.local
    ? `This device: ${formatSize(conflict.local.size)} · ${formatTime(conflict.local.mtime)}`
    : "Deleted on this device";
  const remote = conflict.remote
    ? `Dropbox: ${formatSize(conflict.remote.size)} · ${formatTime(Date.parse(conflict.remote.serverModified))}`
    : "Deleted on Dropbox";

  return `${local}  —  ${remote}`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return "unknown size";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return "unknown time";
  }

  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

class ConflictResolutionModal extends Modal {
  private settled = false;
  private readonly choices = new Map<string, ConflictResolution>();
  private readonly dropdowns = new Map<string, DropdownComponent>();
  private overflowEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly request: ConflictDecisionRequest,
    private readonly resolve: (resolutions: Map<string, ConflictResolution> | null) => void,
  ) {
    super(app);

    for (const conflict of request.conflicts) {
      this.choices.set(
        conflict.path,
        normalizeResolution(
          conflict,
          request.suggestions.get(conflict.path) ?? "skip",
          request.allowKeepBoth(conflict),
        ),
      );
    }
  }

  onOpen(): void {
    const total = this.request.conflicts.length;
    this.titleEl.setText(total === 1 ? "Resolve 1 sync conflict" : `Resolve ${total} sync conflicts`);
    this.modalEl.addClass("vaultbox-conflict-modal");

    this.contentEl.createEl("p", {
      cls: "vaultbox-modal-copy",
      text: "These files changed on this device and in Dropbox since the last sync. Choose what to keep; everything else syncs either way. \"Keep both\" saves the Dropbox version alongside yours.",
    });

    new Setting(this.contentEl)
      .setName("Set every file to")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({
            "": "Choose…",
            "keep-both": "Keep both",
            "keep-local": "Keep this device",
            "keep-remote": "Keep Dropbox",
            skip: "Decide later",
          })
          .setValue("")
          .onChange((value) => {
            if (value) {
              this.setAll(value as ConflictResolution);
              dropdown.setValue("");
            }
          });
      });

    const list = this.contentEl.createDiv({ cls: "vaultbox-conflict-list" });
    for (const conflict of this.request.conflicts.slice(0, MAX_RENDERED_ROWS)) {
      this.renderRow(list, conflict);
    }

    if (total > MAX_RENDERED_ROWS) {
      this.overflowEl = this.contentEl.createEl("p", { cls: "vaultbox-modal-copy" });
      this.updateOverflowText();
    }

    new Setting(this.contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => this.finish(null));
      })
      .addButton((button) => {
        button
          .setButtonText("Resolve and sync")
          .setCta()
          .onClick(() => this.finish(new Map(this.choices)));
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish(null, false);
  }

  private renderRow(list: HTMLElement, conflict: SyncConflict): void {
    const allowKeepBoth = this.request.allowKeepBoth(conflict);
    new Setting(list)
      .setClass("vaultbox-conflict-row")
      .setName(conflictLocalPath(conflict))
      .setDesc(describeConflictSides(conflict))
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(describeConflictChoices(conflict, allowKeepBoth))
          .setValue(this.choices.get(conflict.path) ?? "skip")
          .onChange((value) => {
            this.choices.set(conflict.path, value as ConflictResolution);
          });
        this.dropdowns.set(conflict.path, dropdown);
      });
  }

  private setAll(resolution: ConflictResolution): void {
    for (const conflict of this.request.conflicts) {
      const normalized = normalizeResolution(conflict, resolution, this.request.allowKeepBoth(conflict));
      this.choices.set(conflict.path, normalized);
      this.dropdowns.get(conflict.path)?.setValue(normalized);
    }

    this.updateOverflowText();
  }

  private updateOverflowText(): void {
    if (!this.overflowEl) {
      return;
    }

    const hidden = this.request.conflicts.slice(MAX_RENDERED_ROWS);
    const choices = new Set(hidden.map((conflict) => this.choices.get(conflict.path) ?? "skip"));
    const summary = choices.size === 1
      ? describeResolution([...choices][0])
      : "their suggested choices";
    this.overflowEl.setText(`…and ${hidden.length} more file(s), set to ${summary}. Use "Set every file to" above to change them.`);
  }

  private finish(resolutions: Map<string, ConflictResolution> | null, close = true): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.resolve(resolutions);
    if (close) {
      this.close();
    }
  }
}

export function describeResolution(resolution: ConflictResolution): string {
  switch (resolution) {
    case "keep-both":
      return "keep both";
    case "keep-local":
      return "keep this device";
    case "keep-remote":
      return "keep Dropbox";
    case "skip":
      return "decide later";
  }
}
