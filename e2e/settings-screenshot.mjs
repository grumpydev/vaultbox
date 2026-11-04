import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

async function main() {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runRoot = path.join(repoRoot, "tmp", "screenshots", runId);
  const vaultPath = path.join(runRoot, "vault");
  const userDataPath = path.join(runRoot, "obsidian-user-data");
  const screenshotPath = path.join(repoRoot, "docs", "vaultbox-settings.png");
  const obsidianPath =
    process.env.VAULTBOX_E2E_OBSIDIAN_PATH ||
    "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
  const obsidianCliPath =
    process.env.VAULTBOX_E2E_OBSIDIAN_CLI_PATH ||
    path.join(path.dirname(obsidianPath), "obsidian-cli");

  let browser;
  let obsidian;

  console.log(`Vault: ${vaultPath}`);
  console.log(`Screenshot: ${screenshotPath}`);

  try {
    await assertNoExistingObsidianProcess();
    await prepareVault(vaultPath);
    await prepareObsidianUserData(userDataPath, vaultPath);

    const port = await getFreePort();
    obsidian = launchObsidian(obsidianPath, userDataPath, port);
    browser = await connectToObsidian(port);
    const page = await getObsidianPage(browser, port);
    await waitForExpectedVault(page, vaultPath);
    await disableRestrictedMode(obsidianCliPath, vaultPath);
    await enableVaultboxPlugin(obsidianCliPath, vaultPath);
    await trustVaultIfPrompted(page);
    await waitForPlugin(page);
    await openVaultboxSettings(page);

    await page.setViewportSize({ width: 1440, height: 1300 });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Saved ${screenshotPath}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (obsidian && !obsidian.killed) {
      obsidian.kill("SIGTERM");
    }
  }
}

async function prepareVault(vaultPath) {
  const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "vaultbox");
  await fs.mkdir(pluginPath, { recursive: true });
  await fs.mkdir(path.join(repoRoot, "docs"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Vaultbox screenshot vault\n", "utf8");
  await fs.writeFile(
    path.join(vaultPath, ".obsidian", "community-plugins.json"),
    JSON.stringify(["vaultbox"], null, 2),
  );
  await fs.writeFile(
    path.join(vaultPath, ".obsidian", "app.json"),
    JSON.stringify({ safeMode: false, restrictedMode: false }, null, 2),
  );

  for (const filename of ["main.js", "manifest.json", "styles.css"]) {
    await fs.copyFile(path.join(repoRoot, filename), path.join(pluginPath, filename));
  }

  await fs.writeFile(
    path.join(pluginPath, "data.json"),
    JSON.stringify(
      {
        settings: {
          accessToken: "screenshot-token",
          accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
          refreshToken: "screenshot-refresh-token",
          selectedFolderPath: "/Vault",
          syncMode: "manual",
          confirmBeforeManualSync: true,
          syncIntervalMinutes: 15,
          syncOnStartup: false,
          lastSyncStartedAt: null,
          lastSyncCompletedAt: null,
          lastSyncSummary: "Simulation: Uploads: 0, Downloads: 0, Remote deletes: 0, Local deletes: 0, Conflicts: 0",
          debugLogging: false,
        },
        syncState: {
          files: {},
          lastSyncedAt: 0,
        },
        debugLog: [],
      },
      null,
      2,
    ),
  );
}

async function prepareObsidianUserData(userDataPath, vaultPath) {
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(
    path.join(userDataPath, "obsidian.json"),
    JSON.stringify(
      {
        vaults: {
          "vaultbox-screenshot": {
            path: vaultPath,
            ts: Date.now(),
            open: true,
          },
        },
        cli: true,
      },
      null,
      2,
    ),
  );
}

function launchObsidian(obsidianPath, userDataPath, port) {
  return spawn(
    obsidianPath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataPath}`],
    {
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
      stdio: process.env.VAULTBOX_E2E_VERBOSE === "true" ? "inherit" : "ignore",
    },
  );
}

async function connectToObsidian(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch {
      await delay(500);
    }
  }
  throw new Error(`Timed out connecting to Obsidian at ${endpoint}`);
}

async function getObsidianPage(browser, port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    for (const context of browser.contexts()) {
      const page = context.pages().find((candidate) => !candidate.url().startsWith("devtools://"));
      if (page) {
        return page;
      }
    }

    const targets = await getDebugTargets(port);
    const pageTarget = targets.find((target) => target.type === "page" && target.url !== "about:blank");
    if (pageTarget) {
      const [context] = browser.contexts();
      const page = context.pages().find((candidate) => candidate.url() === pageTarget.url);
      if (page) {
        return page;
      }
    }

    await delay(500);
  }

  throw new Error("Timed out waiting for Obsidian page.");
}

async function waitForExpectedVault(page, vaultPath) {
  const expected = path.resolve(vaultPath);
  await page.waitForFunction(
    (expected) => {
      const vault = globalThis.app?.vault?.adapter?.basePath;
      return typeof vault === "string" && vault === expected;
    },
    expected,
    { timeout: 45000 },
  );
}

async function disableRestrictedMode(obsidianCliPath, vaultPath) {
  await runObsidianCli(obsidianCliPath, vaultPath, ["plugins:restrict", "off"]);
}

async function enableVaultboxPlugin(obsidianCliPath, vaultPath) {
  await runObsidianCli(obsidianCliPath, vaultPath, ["plugin:enable", "id=vaultbox", "filter=community"]);
}

async function runObsidianCli(obsidianCliPath, vaultPath, args) {
  await new Promise((resolve, reject) => {
    execFile(obsidianCliPath, ["--vault", vaultPath, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${obsidianCliPath} ${args.join(" ")} failed: ${stderr || stdout || error.message}`));
        return;
      }
      resolve();
    });
  });
}

async function trustVaultIfPrompted(page) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await page.evaluate(() => {
      if (globalThis.app?.plugins?.plugins?.vaultbox) {
        return "plugin-loaded";
      }

      const trustButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Trust author and enable plugins",
      );

      if (trustButton instanceof HTMLElement) {
        trustButton.click();
        return "trusted";
      }

      return document.body.innerText.includes("Do you trust the author of this vault?")
        ? "waiting"
        : "absent";
    });

    if (result === "trusted") {
      await delay(1000);
      return;
    }
    if (result === "plugin-loaded" || result === "absent") {
      return;
    }
    await delay(500);
  }
}

async function waitForPlugin(page) {
  await page.waitForFunction(
    () => Boolean(globalThis.app?.plugins?.plugins?.vaultbox),
    undefined,
    { timeout: 45000 },
  );
}

async function openVaultboxSettings(page) {
  await page.waitForFunction(
    () => Boolean(globalThis.app?.setting?.open && globalThis.app?.setting?.openTabById),
    undefined,
    { timeout: 30000 },
  );

  await page.waitForFunction(
    () => {
      globalThis.app.setting.open();
      globalThis.app.setting.openTabById("vaultbox");
      return document.body.innerText.includes("Vaultbox") &&
        document.body.innerText.includes("Dropbox vault folder") &&
        document.body.innerText.includes("Simulate sync");
    },
    undefined,
    { timeout: 30000, polling: 500 },
  );

  await page.evaluate(() => {
    document.querySelector(".modal")?.scrollTo({ top: 0 });
  });
}

async function assertNoExistingObsidianProcess() {
  if (process.platform !== "darwin") {
    return;
  }

  const processes = await new Promise((resolve, reject) => {
    execFile("pgrep", ["-fl", "Obsidian"], (error, stdout) => {
      if (error?.code === 1) {
        resolve([]);
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });

  if (processes.length > 0) {
    throw new Error(`Obsidian is already running. Close it first.\n${processes.join("\n")}`);
  }
}

async function getDebugTargets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return response.ok ? await response.json() : [];
  } catch {
    return [];
  }
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

export {
  assertNoExistingObsidianProcess, prepareVault, prepareObsidianUserData,
  getFreePort, launchObsidian, connectToObsidian, getObsidianPage,
  waitForExpectedVault, disableRestrictedMode, enableVaultboxPlugin,
  trustVaultIfPrompted, waitForPlugin, openVaultboxSettings,
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
