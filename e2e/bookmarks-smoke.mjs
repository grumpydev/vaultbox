import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertNoExistingObsidianProcess, prepareVault, prepareObsidianUserData,
  getFreePort, launchObsidian, connectToObsidian, getObsidianPage,
  waitForExpectedVault, disableRestrictedMode, enableVaultboxPlugin,
  trustVaultIfPrompted, waitForPlugin,
} from "./settings-screenshot.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
await fs.mkdir(path.join(root, "tmp"), { recursive: true });
const run = await fs.mkdtemp(path.join(root, "tmp", "bookmarks-smoke-"));
const vault = path.join(run, "vault");
const profile = path.join(run, "profile");
const executable = process.env.VAULTBOX_E2E_OBSIDIAN_PATH || "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const cli = process.env.VAULTBOX_E2E_OBSIDIAN_CLI_PATH || path.join(path.dirname(executable), "obsidian-cli");
const bookmarksPath = path.join(vault, ".obsidian", "bookmarks.json");
let child;
let browser;
let page;

async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    // A settings popout can hold shutdown open. Only this disposable process is owned by the test.
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }
  child = undefined;
  await browser?.close().catch(() => {});
  browser = undefined;
}

async function start() {
  const port = await getFreePort();
  child = launchObsidian(executable, profile, port);
  browser = await connectToObsidian(port);
  for (const context of browser.contexts()) {
    const handleDialogs = (target) => target.on("dialog", (dialog) => { void dialog.accept().catch(() => {}); });
    context.on("page", handleDialogs);
    for (const target of context.pages()) handleDialogs(target);
  }
  page = await getObsidianPage(browser, port);
  await waitForExpectedVault(page, vault);
  await disableRestrictedMode(cli, vault);
  await enableVaultboxPlugin(cli, vault);
  await trustVaultIfPrompted(page);
  await waitForPlugin(page);
}

async function showBookmarks() {
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const leaf = app.workspace.getLeavesOfType("bookmarks")[0] || app.workspace.getLeftLeaf(false);
    await leaf.setViewState({ type: "bookmarks", active: true });
    await app.workspace.revealLeaf(leaf);
  });
}

async function openSettings() {
  await page.bringToFront();
  await page.evaluate(() => {
    app.setting.open();
    app.setting.openTabById("vaultbox");
  });
  // Newer Obsidian versions can open settings in a separate window.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    for (const candidate of browser.contexts().flatMap((context) => context.pages())) {
      if (await candidate.locator(".setting-item-name", { hasText: /^Bookmarks$/ }).isVisible()) return candidate;
    }
    await delay(250);
  }
  throw new Error("Bookmark settings did not appear in any Obsidian window");
}

try {
  await assertNoExistingObsidianProcess();
  await prepareVault(vault);
  await prepareObsidianUserData(profile, vault);
  await fs.writeFile(bookmarksPath, JSON.stringify({ items: [{ type: "group", title: "Before sync", items: [], ctime: 1 }] }));
  await fs.writeFile(path.join(vault, ".obsidian", "core-plugins.json"), JSON.stringify(["bookmarks", "file-explorer"]));
  const dataPath = path.join(vault, ".obsidian", "plugins", "vaultbox", "data.json");
  const data = JSON.parse(await fs.readFile(dataPath, "utf8"));
  data.settings.confirmBeforeManualSync = false;
  await fs.writeFile(dataPath, JSON.stringify(data));
  await start();

  const settingsPage = await openSettings();
  const setting = settingsPage.locator(".setting-item").filter({ has: settingsPage.locator(".setting-item-name", { hasText: /^Bookmarks$/ }) });
  const toggle = setting.locator(".checkbox-container");
  assert.equal(await toggle.evaluate((element) => element.classList.contains("is-enabled")), false);
  await toggle.click();
  await page.waitForFunction(() => app.plugins.plugins.vaultbox.settings.syncBookmarks === true);
  await page.screenshot({ path: path.join(run, "settings.png"), fullPage: true });

  // Only the transport is replaced: use the real planner, executor, adapter and core Bookmarks view.
  await page.evaluate(() => {
    const files = new Map();
    let revision = 0;
    async function put(remotePath, content) {
      const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const block = await crypto.subtle.digest("SHA-256", content);
      const contentHash = hex(await crypto.subtle.digest("SHA-256", block));
      const metadata = {
        tag: "file", name: remotePath.split("/").pop(), pathDisplay: remotePath,
        pathLower: remotePath.toLowerCase(), id: remotePath,
        clientModified: new Date().toISOString(), serverModified: new Date().toISOString(),
        rev: `rev-${++revision}`, size: content.byteLength, contentHash,
      };
      files.set(metadata.pathLower, { metadata, content });
      return metadata;
    }
    window.bookmarkSmoke = { files, put };
    app.plugins.plugins.vaultbox.createDropboxClient = () => ({
      listAllFiles: async () => new Map([...files].map(([key, value]) => [key, value.metadata])),
      createFolder: async () => {},
      upload: async ({ path, content, rev }) => {
        const existing = files.get(path.toLowerCase());
        if ((existing && existing.metadata.rev !== rev) || (!existing && rev)) throw new Error("Stale revision");
        return put(path, content);
      },
      download: async (path) => files.get(path.toLowerCase()).content,
      delete: async () => { throw new Error("Unexpected remote deletion"); },
    });
  });
  await showBookmarks();
  await page.getByText("Before sync", { exact: true }).waitFor();
  await page.evaluate(() => app.plugins.plugins.vaultbox.syncNow());
  assert.equal(await page.evaluate(() => Boolean(app.plugins.plugins.vaultbox.syncState.files[".obsidian/bookmarks.json"])), true);
  console.log("PASS: settings toggle, initial bookmark upload and tracking");

  await page.evaluate(async () => {
    const content = new TextEncoder().encode(JSON.stringify({ items: [{ type: "group", title: "Downloaded bookmarks", items: [], ctime: 2 }] })).buffer;
    await bookmarkSmoke.put("/Vault/.obsidian/bookmarks.json", content);
    await app.plugins.plugins.vaultbox.syncNow();
  });
  assert.match(await fs.readFile(bookmarksPath, "utf8"), /Downloaded bookmarks/);
  await page.getByText("Downloaded bookmarks", { exact: true }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: path.join(run, "downloaded.png"), fullPage: true });
  const plan = await page.evaluate(async () => (await app.plugins.plugins.vaultbox.buildSyncPlan()).summary);
  assert.equal(plan.conflicts + plan.uploads + plan.downloads + plan.localDeletes + plan.remoteDeletes, 0);
  console.log("PASS: downloaded bookmarks appear live; next plan has no changes");

  await stop();
  await start();
  await showBookmarks();
  await page.getByText("Downloaded bookmarks", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => app.plugins.plugins.vaultbox.settings.syncBookmarks), true);
  console.log("PASS: bookmarks and opt-in setting survive a full app restart");

  const reopenedSettings = await openSettings();
  await reopenedSettings.locator(".setting-item").filter({ has: reopenedSettings.locator(".setting-item-name", { hasText: /^Bookmarks$/ }) }).locator(".checkbox-container").click();
  await page.waitForFunction(() => !app.plugins.plugins.vaultbox.settings.syncBookmarks && !app.plugins.plugins.vaultbox.syncState.files[".obsidian/bookmarks.json"]);
  assert.match(await fs.readFile(bookmarksPath, "utf8"), /Downloaded bookmarks/);
  console.log("PASS: disabling clears tracking without deleting the bookmark file");
  console.log(`Artifacts: ${run}`);
} catch (error) {
  await page?.screenshot({ path: path.join(run, "failure.png"), fullPage: true }).catch(() => {});
  console.error(error);
  console.error(`Artifacts: ${run}`);
  process.exitCode = 1;
} finally {
  await stop();
}
