import { App, Modal, Setting } from "obsidian";

interface ConfirmationOptions {
  title: string;
  message: string;
  confirmText: string;
}

export function requestConfirmation(app: App, options: ConfirmationOptions): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmationModal(app, options, resolve).open();
  });
}

class ConfirmationModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly options: ConfirmationOptions,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.options.title);
    this.contentEl.createEl("p", {
      cls: "vaultbox-modal-copy",
      text: this.options.message,
    });

    new Setting(this.contentEl)
      .addButton((button) => {
        button.setButtonText("Cancel").onClick(() => {
          this.finish(false);
        });
      })
      .addButton((button) => {
        button
          .setButtonText(this.options.confirmText)
          .setWarning()
          .onClick(() => {
            this.finish(true);
          });
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.finish(false, false);
  }

  private finish(confirmed: boolean, close = true): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.resolve(confirmed);
    if (close) {
      this.close();
    }
  }
}
