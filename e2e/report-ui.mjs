import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// Browser-only stand-ins for Obsidian's DOM helpers; no vault or Dropbox access.
const obsidian = `
HTMLElement.prototype.createEl = function(tag, options = {}) {
  const el = document.createElement(tag);
  if (options.cls) el.className = options.cls;
  if (options.text) el.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, value);
  this.appendChild(el); return el;
};
HTMLElement.prototype.addClass = function(name) { this.classList.add(name); };
HTMLElement.prototype.setText = function(text) { this.textContent = text; };
HTMLElement.prototype.empty = function() { this.replaceChildren(); };
export class App {}
export class Notice { constructor(message) { window.lastNotice = message; } }
export class Modal {
  constructor() {
    this.modalEl = document.body.createEl('div', {cls: 'modal'});
    this.titleEl = this.modalEl.createEl('div', {cls: 'modal-title'});
    this.contentEl = this.modalEl.createEl('div');
  }
  open() { this.onOpen(); }
  close() { this.onClose(); this.modalEl.remove(); }
}
export class Setting {
  constructor(el) {
    this.control = el.createEl('div', {cls: 'setting-item'}).createEl('div', {cls: 'setting-item-control'});
  }
  addButton(callback) {
    const el = this.control.createEl('button');
    const button = {
      setButtonText(text) { el.textContent = text; return this; },
      setIcon() { el.textContent = 'Copy'; return this; },
      setTooltip(text) { el.setAttribute('aria-label', text); return this; },
      onClick(handler) { el.addEventListener('click', handler); return this; }
    };
    callback(button); return this;
  }
}
`;

const bundle = await build({
  stdin: {
    contents: `import { SyncReportModal } from './src/sync-report-modal';
      window.openReport = text => new SyncReportModal({}, text).open();`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: "iife",
  plugins: [{ name: "obsidian-test", setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: obsidian, loader: "js" }));
  } }],
});

await mkdir("tmp/report-ui", { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(`<style>
      :root { --font-monospace: monospace; --font-ui-small: 14px; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: sans-serif; background: #eee; }
      .modal { box-sizing: border-box; background: white; padding: 16px; border-radius: 8px; }
      .modal-title { font-size: 22px; margin-bottom: 16px; }
      .setting-item-control { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
      button { min-height: 36px; }
      </style>`);
    await page.addStyleTag({ content: await readFile("styles.css", "utf8") });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const report = ["Simulation snapshot (not applied)", "Local deletes (22)",
      ...Array.from({ length: 22 }, (_, i) => `- "Notes/Delete-${i}.md"`),
      "Downloads (184)", ...Array.from({ length: 184 }, (_, i) => `- "Downloads/${i}.md"`),
      `- "${"long".repeat(200)}.md"`, '<img src=x onerror="window.injected=true">',
    ].join("\n");
    await page.evaluate((report) => window.openReport(report), report);
    const preview = page.getByRole("textbox", { name: "Complete simulation report" });
    assert.equal(await preview.inputValue(), report);
    assert.equal(await preview.getAttribute("readonly"), "");
    assert.equal(await page.locator("img").count(), 0);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: async (text) => { window.copied = text; } },
    }));
    await page.getByRole("button", { name: "Copy complete report" }).click();
    assert.equal(await page.evaluate(() => window.copied), report);
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: async () => { throw new Error("Denied"); } },
    }));
    await page.getByRole("button", { name: "Copy complete report" }).click();
    assert.equal(await preview.evaluate((el) => el.selectionEnd - el.selectionStart), report.length);
    assert.match(await page.evaluate(() => window.lastNotice), /manual copying/);
    await preview.evaluate((el) => el.setSelectionRange(0, 0));
    await page.getByRole("button", { name: "Select all" }).click();
    assert.equal(await preview.evaluate((el) => el.selectionEnd - el.selectionStart), report.length);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    for (const button of await page.getByRole("button").all()) {
      const box = await button.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width);
    }
    await preview.evaluate((el) => { el.setSelectionRange(0, 0); el.scrollTop = 0; el.blur(); });
    await page.screenshot({ path: `tmp/report-ui/${viewport.width}.png` });
    await page.getByRole("button", { name: "Close" }).click();
    assert.equal(await page.locator(".modal").count(), 0);
    assert.deepEqual(errors, []);
    console.log(`Report UI passed at ${viewport.width}x${viewport.height}`);
    await page.close();
  }
} finally {
  await browser.close();
}
