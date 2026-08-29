import { App, Modal, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import { requestConfirmation } from "./confirmation-modal";
import { getValidExcludePatterns, getValidExtraHiddenDirs } from "./sync-policy";
import type { DropboxFolderMetadata } from "./types";
import type VaultboxPlugin from "./main";

const SUPPORT_LINKS = {
  githubSponsors: "https://github.com/sponsors/grumpydev",
  koFi: "https://ko-fi.com/grumpydev",
};

export class VaultboxSettingTab extends PluginSettingTab {
  private statusEl: HTMLElement | null = null;

  constructor(app: App, private readonly plugin: VaultboxPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.addHeader(containerEl);
    this.statusEl = containerEl.createDiv({ cls: "vaultbox-status" });
    this.setStatus(this.plugin.isConnected() ? "Dropbox connected." : "Dropbox is not connected.");

    new Setting(containerEl)
      .setName("Connect Dropbox")
      .setDesc("Opens Dropbox OAuth. Dropbox displays a code you paste below; no client secret is stored in Vaultbox.")
      .addButton((button) => {
        button
          .setButtonText(this.plugin.isConnected() ? "Reconnect" : "Connect")
          .setCta()
          .onClick(async () => {
            try {
              await this.plugin.startDropboxAuth();
              this.setStatus("Dropbox opened. Paste the authorization code after approving access.");
            } catch (error) {
              this.setStatus(error instanceof Error ? error.message : String(error));
            }
          });
      });

    if (!this.plugin.isConnected()) {
      new Setting(containerEl)
        .setName("Authorization code")
        .setDesc("Paste the code Dropbox shows after approval.")
        .addText((text) => {
          text.setPlaceholder("Dropbox authorization code");
        })
        .addButton((button) => {
          button
            .setButtonText("Save code")
            .onClick(async () => {
              const input = button.buttonEl.parentElement?.querySelector("input");
              const code = input instanceof HTMLInputElement ? input.value.trim() : "";
              if (!code) {
                new Notice("Paste a Dropbox authorization code first.");
                return;
              }

              try {
                await this.plugin.finishDropboxAuth(code);
                this.display();
              } catch (error) {
                this.setStatus(error instanceof Error ? error.message : String(error));
              }
            });
        });
    }

    new Setting(containerEl)
      .setName("Dropbox vault folder")
      .setDesc(
        this.plugin.settings.selectedFolderPath ||
        "Choose an existing Dropbox folder. The Dropbox root cannot be used.",
      )
      .addButton((button) => {
        button
          .setButtonText("Choose")
          .setCta()
          .onClick(() => {
            if (!this.plugin.isConnected()) {
              new Notice("Connect Dropbox before choosing a folder.");
              return;
            }

            new DropboxFolderPickerModal(this.app, this.plugin, async (folderPath) => {
              this.plugin.settings.selectedFolderPath = folderPath;
              await this.plugin.saveSettings();
              this.display();
            }).open();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Validate")
          .onClick(async () => {
            try {
              await this.plugin.validateSelectedFolder();
              this.display();
            } catch (error) {
              this.setStatus(error instanceof Error ? error.message : String(error));
            }
          });
      });

    this.addSyncSettings(containerEl);
    this.addConfigurationSyncSettings(containerEl);
    this.addDebugSettings(containerEl);
    this.addSupport(containerEl);
    this.addActions(containerEl);
  }

  private addHeader(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Dropbox sync")
      .setHeading();

    const header = containerEl.createDiv({ cls: "vaultbox-settings-header" });
    const icon = header.createDiv({ cls: "vaultbox-settings-logo" });
    icon.setAttr("aria-hidden", "true");
    setIcon(icon, "vaultbox-logo");
    header.createDiv({
      cls: "vaultbox-settings-tagline",
      text: "Dropbox folder sync for desktop and mobile vaults.",
    });
  }

  private addSyncSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Sync mode")
      .setDesc("Manual and automatic sync will use the same plan-first engine as Octosync.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("manual", "Manual")
          .addOption("automatic", "Automatic")
          .setValue(this.plugin.settings.syncMode)
          .onChange(async (value) => {
            this.plugin.settings.syncMode = value === "automatic" ? "automatic" : "manual";
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (this.plugin.settings.syncMode === "automatic") {
      new Setting(containerEl)
        .setName("Sync on startup")
        .setDesc("Planned for automatic sync mode.")
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.syncOnStartup)
            .onChange(async (value) => {
              this.plugin.settings.syncOnStartup = value;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("Sync interval")
        .setDesc("Minutes between automatic sync attempts.")
        .addText((text) => {
          text
            .setValue(String(this.plugin.settings.syncIntervalMinutes))
            .onChange(async (value) => {
              this.plugin.settings.syncIntervalMinutes = Math.max(0, Number.parseInt(value, 10) || 0);
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "number";
          text.inputEl.min = "0";
          text.inputEl.step = "1";
        });
    } else {
      new Setting(containerEl)
        .setName("Confirm before sync")
        .setDesc("Build the sync plan first, then ask before applying changes.")
        .addToggle((toggle) => {
          toggle
            .setValue(this.plugin.settings.confirmBeforeManualSync)
            .onChange(async (value) => {
              this.plugin.settings.confirmBeforeManualSync = value;
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName("Last sync")
      .setDesc(this.plugin.settings.lastSyncSummary || "No completed sync yet.");

    new Setting(containerEl)
      .setName("Reset sync tracking")
      .setDesc(
        "Clears Vaultbox's local sync metadata without changing local files or Dropbox. Use this after clearing or replacing the Dropbox folder so the next sync starts fresh.",
      )
      .addButton((button) => {
        button
          .setButtonText("Reset tracking")
          .onClick(async () => {
            const confirmed = await requestConfirmation(this.app, {
              title: "Reset sync tracking?",
              message: [
                "This will not delete local files or Dropbox files.",
                "The next sync will treat this vault and the selected Dropbox folder as a fresh setup.",
              ].join("\n\n"),
              confirmText: "Reset tracking",
            });
            if (!confirmed) {
              return;
            }

            await this.plugin.resetSyncState();
            new Notice("Vaultbox sync tracking reset.");
            this.display();
          });
      });
  }

  private addDebugSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Store a small rolling sync log in plugin data. Tokens are redacted.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    if (!this.plugin.settings.debugLogging && this.plugin.getDebugLogCount() === 0) {
      return;
    }

    new Setting(containerEl)
      .setName("Debug log")
      .setDesc(`${this.plugin.getDebugLogCount()} entries. The log is shown below and can be selected manually.`)
      .addButton((button) => {
        button
          .setButtonText("Clear")
          .onClick(async () => {
            await this.plugin.clearDebugLog();
            new Notice("Vaultbox debug log cleared.");
            this.display();
          });
      });

    const preview = containerEl.createEl("textarea", {
      cls: "vaultbox-debug-log",
    });
    preview.readOnly = true;
    preview.value = this.plugin.getDebugLogText();
  }

  private addConfigurationSyncSettings(containerEl: HTMLElement): void {
    const configDir = this.app.vault.configDir;

    new Setting(containerEl)
      .setName("Configuration sync")
      .setHeading();

    new Setting(containerEl)
      .setName("Community plugin list")
      .setDesc(`Sync ${configDir}/community-plugins.json. Plugin settings, plugin binaries, and stored tokens are never included.`)
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncCommunityPlugins)
          .onChange(async (value) => {
            this.plugin.settings.syncCommunityPlugins = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Themes")
      .setDesc(`Sync files under ${configDir}/themes.`)
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncThemes)
          .onChange(async (value) => {
            this.plugin.settings.syncThemes = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("CSS snippets")
      .setDesc(`Sync files under ${configDir}/snippets.`)
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.syncSnippets)
          .onChange(async (value) => {
            this.plugin.settings.syncSnippets = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Extra hidden directories")
      .setDesc("Enter one top-level hidden directory per line. Reserved and nested paths are ignored.")
      .addTextArea((textArea) => {
        textArea
          .setValue(this.plugin.settings.syncExtraHiddenDirs.join("\n"))
          .setPlaceholder("Hidden directory names")
          .onChange(async (value) => {
            this.plugin.settings.syncExtraHiddenDirs = value
              .split("\n")
              .map((entry) => entry.trim())
              .filter(Boolean);
            this.plugin.settings.syncExtraHiddenDirs = getValidExtraHiddenDirs(
              this.plugin.settings,
              configDir,
            );
            await this.plugin.saveSettings();
          });
        textArea.inputEl.rows = 4;
      });

    new Setting(containerEl)
      .setName("Hidden-path exclusions")
      .setDesc("One path prefix or filename per line. These exclusions apply only inside the configuration and hidden directories enabled above.")
      .addTextArea((textArea) => {
        textArea
          .setValue(this.plugin.settings.syncExcludePaths.join("\n"))
          .setPlaceholder(`${configDir}/themes/example\ndata.json`)
          .onChange(async (value) => {
            this.plugin.settings.syncExcludePaths = getValidExcludePatterns(value.split("\n"));
            await this.plugin.saveSettings();
          });
        textArea.inputEl.rows = 4;
      });
  }

  private addActions(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Simulate sync")
      .setDesc("Scans the vault and Dropbox, builds the sync plan, and reports what would happen without changing files or metadata.")
      .addButton((button) => {
        button
          .setButtonText("Simulate")
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Simulating...");
            await this.plugin.simulateSync();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Manual sync")
      .setDesc("Run a sync now.")
      .addButton((button) => {
        button
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            button.setButtonText("Syncing...");
            await this.plugin.syncNow();
            this.display();
          });
      });
  }

  private addSupport(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Support Vaultbox")
      .setDesc(
        "Vaultbox is free to use. If it saves you time, you can support ongoing development with a voluntary tip.",
      )
      .addButton((button) => {
        button
          .setButtonText("GitHub Sponsors")
          .onClick(() => {
            window.open(SUPPORT_LINKS.githubSponsors, "_blank", "noopener,noreferrer");
          });
      })
      .addButton((button) => {
        button
          .setButtonText("Ko-fi")
          .onClick(() => {
            window.open(SUPPORT_LINKS.koFi, "_blank", "noopener,noreferrer");
          });
      });
  }

  private setStatus(message: string): void {
    if (this.statusEl) {
      this.statusEl.setText(message);
    }
  }
}

class DropboxFolderPickerModal extends Modal {
  private currentPath = "";
  private statusEl: HTMLElement | null = null;
  private foldersEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly plugin: VaultboxPlugin,
    private readonly onChoose: (folderPath: string) => Promise<void>,
  ) {
    super(app);
    this.currentPath = this.plugin.settings.selectedFolderPath;
  }

  onOpen(): void {
    this.titleEl.setText("Choose Dropbox folder");
    this.render();
    void this.loadFolders();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      cls: "vaultbox-modal-copy",
      text: "Choose the Dropbox folder that contains this vault. The Dropbox root cannot be selected.",
    });

    const current = this.contentEl.createDiv({ cls: "vaultbox-picker-current" });
    current.createSpan({ text: "Current folder" });
    current.createSpan({ text: this.currentPath || "Dropbox root" });

    this.statusEl = this.contentEl.createDiv({ cls: "vaultbox-status" });
    this.foldersEl = this.contentEl.createDiv({ cls: "vaultbox-folder-list" });

    const newFolder = this.contentEl.createDiv({ cls: "vaultbox-new-folder" });
    const input = newFolder.createEl("input", {
      attr: {
        placeholder: "New folder name",
        type: "text",
      },
    });
    const createButton = newFolder.createEl("button", { text: "Create folder" });
    const createFromInput = async () => {
      await this.createFolder(input.value);
    };
    createButton.addEventListener("click", () => {
      void createFromInput();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void createFromInput();
      }
    });

    const actions = this.contentEl.createDiv({ cls: "vaultbox-modal-actions" });
    actions.createEl("button", { text: "Up" }).addEventListener("click", () => {
      this.currentPath = getParentPath(this.currentPath);
      this.render();
      void this.loadFolders();
    });

    const chooseButton = actions.createEl("button", {
      cls: "mod-cta",
      text: "Choose this folder",
    });
    chooseButton.disabled = !this.currentPath;
    chooseButton.addEventListener("click", () => {
      if (!this.currentPath) {
        this.setStatus("Choose a folder below the Dropbox root.");
        return;
      }

      void this.onChoose(this.currentPath).then(() => {
        this.close();
      });
    });

    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
      this.close();
    });
  }

  private async loadFolders(): Promise<void> {
    try {
      this.setStatus("Loading folders...");
      const folders = await this.plugin.createDropboxClient().listFolders(this.currentPath);
      this.renderFolders(folders);
      this.setStatus(folders.length === 0 ? "No child folders found." : `Loaded ${folders.length} folder${folders.length === 1 ? "" : "s"}.`);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  private renderFolders(folders: DropboxFolderMetadata[]): void {
    if (!this.foldersEl) {
      return;
    }

    this.foldersEl.empty();
    for (const folder of folders) {
      const button = this.foldersEl.createEl("button", {
        cls: "vaultbox-folder-option",
        text: folder.name,
      });
      button.addEventListener("click", () => {
        this.currentPath = folder.pathDisplay || folder.pathLower;
        this.render();
        void this.loadFolders();
      });
    }
  }

  private async createFolder(name: string): Promise<void> {
    const folderName = name.trim();

    if (!folderName) {
      this.setStatus("Enter a folder name first.");
      return;
    }

    if (folderName.includes("/") || folderName.includes("\\")) {
      this.setStatus("Folder names cannot contain slashes.");
      return;
    }

    const folderPath = `${this.currentPath}/${folderName}`.replace(/\/+/g, "/");
    try {
      this.setStatus("Creating folder...");
      await this.plugin.createDropboxClient().createFolder(folderPath);
      this.currentPath = folderPath;
      this.render();
      await this.loadFolders();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  private setStatus(message: string): void {
    this.statusEl?.setText(message);
  }
}

function getParentPath(folderPath: string): string {
  if (!folderPath) {
    return "";
  }

  const parts = folderPath.split("/").filter(Boolean);
  parts.pop();
  return parts.length === 0 ? "" : `/${parts.join("/")}`;
}
