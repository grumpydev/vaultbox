import { App, Modal, Notice, Setting } from "obsidian";

export class SyncReportModal extends Modal {
  constructor(app: App, private readonly report: string) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Simulation report");
    this.modalEl.addClass("vaultbox-report-modal");
    const preview = this.contentEl.createEl("textarea", {
      cls: "vaultbox-sync-report",
      attr: { "aria-label": "Complete simulation report", spellcheck: "false" },
    });
    preview.readOnly = true;
    preview.value = this.report;

    const selectReport = () => {
      preview.focus();
      preview.select();
      preview.setSelectionRange(0, preview.value.length);
    };

    new Setting(this.contentEl)
      .addButton((button) => {
        button.setIcon("copy").setTooltip("Copy complete report").onClick(() => {
          void this.copyReport(preview, selectReport);
        });
      })
      .addButton((button) => {
        button.setButtonText("Select all").onClick(selectReport);
      })
      .addButton((button) => {
        button.setButtonText("Close").onClick(() => this.close());
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async copyReport(preview: HTMLTextAreaElement, selectReport: () => void): Promise<void> {
    try {
      const clipboard = preview.ownerDocument.defaultView?.navigator.clipboard;
      if (!clipboard) {
        throw new Error("Clipboard unavailable");
      }
      await clipboard.writeText(this.report);
      new Notice("Simulation report copied.");
    } catch {
      selectReport();
      new Notice("Clipboard unavailable. The report is selected for manual copying.");
    }
  }
}
