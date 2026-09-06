import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { TFile, Vault } from "obsidian";
import { DropboxClient, normalizeDropboxPath } from "../src/dropbox";
import { executeSyncPlan as executeSyncPlanRaw } from "../src/sync-executor";
import {
  createRemoteFileSnapshot,
  createSyncPlan,
  getDropboxContentHash,
  normalizePathKey,
  scanLocalVault,
  type SyncConflictType,
  type SyncPlan,
} from "../src/sync-plan";
import { createSyncPathPolicy } from "../src/sync-policy";
import { DEFAULT_SETTINGS, type DropboxFileMetadata, type VaultboxSyncState } from "../src/types";
import { setRequestUrlMock } from "../tests/mocks/obsidian";

type ExecuteSyncPlanArgs = Parameters<typeof executeSyncPlanRaw>[0];
const DEFAULT_POLICY = createSyncPathPolicy(DEFAULT_SETTINGS, ".obsidian");

function executeSyncPlan(args: Omit<ExecuteSyncPlanArgs, "fileManager" | "pathPolicy">): ReturnType<typeof executeSyncPlanRaw> {
  return executeSyncPlanRaw({
    ...args,
    pathPolicy: DEFAULT_POLICY,
    fileManager: {
      trashFile: async (file: TFile) => {
        await args.vault.delete(file);
      },
    } as never,
  });
}

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_APP_KEY = "k671hqjipp2sdpl";

describe("live Dropbox sync engine E2E", () => {
  let config: E2EConfig;
  let client: DropboxClient;
  let runRoot: string;

  beforeAll(async () => {
    config = getConfig(await loadEnv());
    installRequestUrlFetchMock(config);
    client = new DropboxClient({ getAccessToken: () => getAccessToken(config) });
    runRoot = joinDropboxPath(
      config.testRoot,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`,
    );
    await ensureDropboxFolder(client, runRoot);
  }, 60_000);

  afterAll(async () => {
    if (!config?.keepArtifacts && client && runRoot) {
      await client.delete(runRoot).catch((error) => {
        console.warn(`Could not delete ${runRoot}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    setRequestUrlMock(null);
  }, 60_000);

  it("applies upload, download, edit, and delete operations against Dropbox", async () => {
    const root = joinDropboxPath(runRoot, "roundtrip");
    await ensureDropboxFolder(client, root);
    const vault = new FakeVault({
      "Local/Nested.md": "local first\n",
    });
    await uploadText(client, root, "Remote.md", "remote first\n");

    let state = emptyState();
    let plan = await buildPlan(vault, root, state, client);
    expect(plan.summary).toMatchObject({ uploads: 1, downloads: 1, conflicts: 0 });

    let result = await executeSyncPlan({
      vault: vault.asVault(),
      dropbox: client,
      rootPath: root,
      plan,
      currentState: state,
    });
    state = result.state;
    expect(await downloadText(client, root, "Local/Nested.md")).toBe("local first\n");
    expect(vault.text("Remote.md")).toBe("remote first\n");

    vault.write("Local/Nested.md", "local edited\n");
    plan = await buildPlan(vault, root, state, client);
    expect(plan.summary).toMatchObject({ uploads: 1, downloads: 0, conflicts: 0 });
    result = await executeSyncPlan({
      vault: vault.asVault(),
      dropbox: client,
      rootPath: root,
      plan,
      currentState: state,
    });
    state = result.state;
    expect(await downloadText(client, root, "Local/Nested.md")).toBe("local edited\n");

    await updateText(client, root, "Remote.md", "remote edited\n");
    plan = await buildPlan(vault, root, state, client);
    expect(plan.summary).toMatchObject({ uploads: 0, downloads: 1, conflicts: 0 });
    result = await executeSyncPlan({
      vault: vault.asVault(),
      dropbox: client,
      rootPath: root,
      plan,
      currentState: state,
    });
    state = result.state;
    expect(vault.text("Remote.md")).toBe("remote edited\n");

    vault.remove("Local/Nested.md");
    plan = await buildPlan(vault, root, state, client);
    expect(plan.summary).toMatchObject({ remoteDeletes: 1, localDeletes: 0, conflicts: 0 });
    result = await executeSyncPlan({
      vault: vault.asVault(),
      dropbox: client,
      rootPath: root,
      plan,
      currentState: state,
    });
    state = result.state;
    await expectMissingRemote(client, root, "Local/Nested.md");

    await client.delete(joinDropboxPath(root, "Remote.md"));
    plan = await buildPlan(vault, root, state, client);
    expect(plan.summary).toMatchObject({ remoteDeletes: 0, localDeletes: 1, conflicts: 0 });
    result = await executeSyncPlan({
      vault: vault.asVault(),
      dropbox: client,
      rootPath: root,
      plan,
      currentState: state,
    });
    expect(result.applied).toBe(1);
    expect(vault.hasFile("Remote.md")).toBe(false);
  }, 120_000);

  it("detects live Dropbox conflict scenarios before execution", async () => {
    await expectLiveConflict("both-new", "both-new", async (root) => {
      const vault = new FakeVault({ "Same.md": "local\n" });
      await uploadText(client, root, "Same.md", "remote\n");
      return { vault, state: emptyState() };
    });

    await expectLiveConflict("path-case-mismatch", "path-case-mismatch", async (root) => {
      const vault = new FakeVault({ "Notes/A.md": "same\n" });
      await uploadText(client, root, "notes/a.md", "same\n");
      return { vault, state: emptyState() };
    });

    await expectLiveConflict("both-modified", "both-modified", async (root) => {
      const seeded = await seedSynced(root, "A.md", "base\n");
      seeded.vault.write("A.md", "local\n");
      await updateText(client, root, "A.md", "remote\n");
      return seeded;
    });

    await expectLiveConflict("local-delete-remote-edit", "local-delete-remote-edit", async (root) => {
      const seeded = await seedSynced(root, "A.md", "base\n");
      seeded.vault.remove("A.md");
      await updateText(client, root, "A.md", "remote\n");
      return seeded;
    });

    await expectLiveConflict("local-edit-remote-delete", "local-edit-remote-delete", async (root) => {
      const seeded = await seedSynced(root, "A.md", "base\n");
      seeded.vault.write("A.md", "local\n");
      await client.delete(joinDropboxPath(root, "A.md"));
      return seeded;
    });

    await expectLiveConflict("local-file-remote-folder", "path-shape-conflict", async (root) => {
      const vault = new FakeVault({ "Notes": "local file\n" });
      await uploadText(client, root, "Notes/A.md", "remote nested\n");
      return { vault, state: emptyState() };
    });

    await expectLiveConflict("remote-file-local-folder", "path-shape-conflict", async (root) => {
      const vault = new FakeVault({ "Notes/A.md": "local nested\n" });
      await uploadText(client, root, "Notes", "remote file\n");
      return { vault, state: emptyState() };
    });
  }, 180_000);

  it("covers case-conflict planner modes that Dropbox itself prevents", async () => {
    const localCaseVault = new FakeVault({
      "Case.md": "a",
      "case.md": "b",
    });
    const localCasePlan = createSyncPlan({
      localFiles: await scanLocalVault(localCaseVault.asVault(), DEFAULT_POLICY),
      remoteFiles: new Map(),
      state: emptyState(),
    });
    expect(localCasePlan.conflicts.map((conflict) => conflict.type)).toContain("local-case-conflict");

    const hash = await getDropboxContentHash(bytes("a"));
    const remoteCasePlan = createSyncPlan({
      localFiles: new Map(),
      remoteFiles: createRemoteFileSnapshot(
        new Map([
          ["one", remoteFile("/Vault/Case.md", hash, "rev-a")],
          ["two", remoteFile("/Vault/case.md", hash, "rev-b")],
        ]),
        "/Vault",
        DEFAULT_POLICY,
      ),
      state: emptyState(),
    });
    expect(remoteCasePlan.conflicts.map((conflict) => conflict.type)).toContain("remote-case-conflict");
  });

  it("treats Unicode-equivalent local and Dropbox paths as one file", async () => {
    const root = joinDropboxPath(runRoot, "unicode-paths");
    await ensureDropboxFolder(client, root);
    const composedPath = "Notes/Caf\u00e9.png";
    const decomposedPath = "Notes/Cafe\u0301.png";
    const content = "same content\n";
    const vault = new FakeVault({ [composedPath]: content });
    await uploadText(client, root, decomposedPath, content);

    const plan = await buildPlan(vault, root, emptyState(), client);

    expect(plan.summary).toMatchObject({
      uploads: 0,
      downloads: 0,
      remoteDeletes: 0,
      localDeletes: 0,
      noops: 1,
      conflicts: 0,
    });
  }, 60_000);

  it("blocks visually equivalent upload and remote delete paths", async () => {
    const root = joinDropboxPath(runRoot, "visual-path-collision");
    await ensureDropboxFolder(client, root);
    const localPath = "Notes/Example File.png";
    const remotePath = "Notes/Example\u00a0File.png";
    const content = "same content\n";
    const vault = new FakeVault({ [localPath]: content });
    const uploaded = await uploadText(client, root, remotePath, content);
    const previous = {
      path: remotePath,
      pathLower: normalizePathKey(remotePath),
      localContentHash: uploaded.contentHash,
      remoteContentHash: uploaded.contentHash,
      remoteRev: uploaded.rev,
    };
    const state: VaultboxSyncState = {
      files: { [previous.pathLower]: previous },
      lastSyncedAt: Date.now(),
    };

    const plan = await buildPlan(vault, root, state, client);

    expect(plan.summary).toMatchObject({ uploads: 1, remoteDeletes: 1, conflicts: 1 });
    expect(plan.conflicts.map((conflict) => conflict.type)).toContain("duplicate-operation-target");
    await expect(executeSyncPlan({
      vault: vault.asVault(),
      dropbox: client,
      rootPath: root,
      plan,
      currentState: state,
    })).rejects.toThrow(/conflict/);
  }, 60_000);

  async function expectLiveConflict(
    name: string,
    expected: SyncConflictType,
    setup: (root: string) => Promise<{ vault: FakeVault; state: VaultboxSyncState }>,
  ): Promise<void> {
    const root = joinDropboxPath(runRoot, "conflicts", name);
    await ensureDropboxFolder(client, root);
    const { vault, state } = await setup(root);
    const plan = await buildPlan(vault, root, state, client);
    expect(plan.conflicts.map((conflict) => conflict.type)).toContain(expected);
    await expect(
      executeSyncPlan({
        vault: vault.asVault(),
        dropbox: client,
        rootPath: root,
        plan,
        currentState: state,
      }),
    ).rejects.toThrow(/conflict/);
  }

  async function seedSynced(root: string, relativePath: string, content: string): Promise<{
    vault: FakeVault;
    state: VaultboxSyncState;
  }> {
    const vault = new FakeVault({ [relativePath]: content });
    const plan = await buildPlan(vault, root, emptyState(), client);
    const result = await executeSyncPlan({
      vault: vault.asVault(),
      dropbox: client,
      rootPath: root,
      plan,
      currentState: emptyState(),
    });
    return { vault, state: result.state };
  }
});

async function buildPlan(
  vault: FakeVault,
  rootPath: string,
  state: VaultboxSyncState,
  client: DropboxClient,
): Promise<SyncPlan> {
  const [localFiles, remoteFiles] = await Promise.all([
    scanLocalVault(vault.asVault(), DEFAULT_POLICY),
    client.listAllFiles(rootPath),
  ]);
  return createSyncPlan({
    localFiles,
    remoteFiles: createRemoteFileSnapshot(remoteFiles, rootPath, DEFAULT_POLICY),
    state,
  });
}

class FakeVault {
  private readonly files = new Map<string, ArrayBuffer>();
  private readonly folders = new Set<string>();

  constructor(initialFiles: Record<string, string>) {
    for (const [filePath, value] of Object.entries(initialFiles)) {
      this.write(filePath, value);
    }
  }

  asVault(): Vault {
    return {
      getFiles: () => [...this.files.keys()].map((filePath) => this.file(filePath)),
      getFileByPath: (filePath: string) => this.hasFile(filePath) ? this.file(filePath) : null,
      getFolderByPath: (folderPath: string) => this.folders.has(folderPath) ? { path: folderPath } : null,
      createFolder: async (folderPath: string) => {
        this.folders.add(folderPath);
        return { path: folderPath };
      },
      readBinary: async (file: TFile) => {
        const content = this.files.get(file.path);
        if (!content) {
          throw new Error(`Missing local file: ${file.path}`);
        }
        return content;
      },
      modifyBinary: async (file: TFile, content: ArrayBuffer) => {
        this.files.set(file.path, cloneBuffer(content));
      },
      createBinary: async (filePath: string, content: ArrayBuffer) => {
        this.addParentFolders(filePath);
        this.files.set(filePath, cloneBuffer(content));
        return this.file(filePath);
      },
      delete: async (file: TFile) => {
        this.files.delete(file.path);
      },
    } as unknown as Vault;
  }

  write(filePath: string, value: string): void {
    this.addParentFolders(filePath);
    this.files.set(filePath, bytes(value));
  }

  remove(filePath: string): void {
    this.files.delete(filePath);
  }

  hasFile(filePath: string): boolean {
    return this.files.has(filePath);
  }

  text(filePath: string): string {
    const content = this.files.get(filePath);
    if (!content) {
      throw new Error(`Missing local file: ${filePath}`);
    }
    return new TextDecoder().decode(content);
  }

  private file(filePath: string): TFile {
    return {
      path: filePath,
      name: filePath.split("/").pop() ?? filePath,
      stat: {
        ctime: 1,
        mtime: 1,
        size: this.files.get(filePath)?.byteLength ?? 0,
      },
    } as TFile;
  }

  private addParentFolders(filePath: string): void {
    const parts = filePath.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.folders.add(current);
    }
  }
}

function installRequestUrlFetchMock(config: E2EConfig): void {
  setRequestUrlMock(async (request) => {
    const headers = { ...(request.headers ?? {}) };
    let body: BodyInit | undefined = request.body;
    if (headers["Content-Type"] === "application/octet-stream" && typeof request.body === "string") {
      body = binaryStringToBytes(request.body);
    }

    if (headers.Authorization === "Bearer ") {
      headers.Authorization = `Bearer ${await getAccessToken(config)}`;
    }

    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers,
      body,
    });
    const buffer = await response.arrayBuffer();
    const text = bufferToBinaryString(buffer);
    let json: unknown = {};
    try {
      json = JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      json = {};
    }

    return {
      status: response.status,
      text,
      arrayBuffer: buffer,
      json,
      headers: Object.fromEntries(response.headers.entries()),
    };
  });
}

let cachedAccessToken = "";
let cachedAccessTokenExpiresAt = 0;

async function getAccessToken(config: E2EConfig): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refreshToken,
      client_id: config.appKey,
    }),
  });

  if (!response.ok) {
    throw new Error(`Dropbox OAuth refresh failed with ${response.status}: ${await response.text()}`);
  }

  const json = await response.json() as { access_token: string; expires_in?: number };
  cachedAccessToken = json.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Math.max(0, (json.expires_in ?? 14_400) - 60) * 1000;
  return cachedAccessToken;
}

async function ensureDropboxFolder(client: DropboxClient, folderPath: string): Promise<void> {
  const parts = normalizeDropboxPath(folderPath).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = joinDropboxPath(current, part);
    await client.createFolder(current);
  }
}

async function uploadText(client: DropboxClient, rootPath: string, relativePath: string, value: string): Promise<DropboxFileMetadata> {
  const dropboxPath = joinDropboxPath(rootPath, relativePath);
  await ensureDropboxFolder(client, parentDropboxPath(dropboxPath));
  return client.upload({
    path: dropboxPath,
    content: bytes(value),
  });
}

async function updateText(client: DropboxClient, rootPath: string, relativePath: string, value: string): Promise<DropboxFileMetadata> {
  const dropboxPath = joinDropboxPath(rootPath, relativePath);
  const metadata = await client.getMetadata(dropboxPath);
  if (metadata.tag !== "file") {
    throw new Error(`${dropboxPath} is not a file.`);
  }
  return client.upload({
    path: dropboxPath,
    content: bytes(value),
    rev: metadata.rev,
  });
}

async function downloadText(client: DropboxClient, rootPath: string, relativePath: string): Promise<string> {
  return new TextDecoder().decode(await client.download(joinDropboxPath(rootPath, relativePath)));
}

async function expectMissingRemote(client: DropboxClient, rootPath: string, relativePath: string): Promise<void> {
  await expect(client.getMetadata(joinDropboxPath(rootPath, relativePath))).rejects.toThrow(/not_found/);
}

function remoteFile(filePath: string, contentHash: string, rev: string): DropboxFileMetadata {
  return {
    tag: "file",
    name: filePath.split("/").pop() ?? filePath,
    pathDisplay: filePath,
    pathLower: normalizePathKey(filePath),
    id: `id:${filePath}`,
    clientModified: "2026-01-01T00:00:00Z",
    serverModified: "2026-01-01T00:00:01Z",
    rev,
    size: 1,
    contentHash,
  };
}

function emptyState(): VaultboxSyncState {
  return {
    files: {},
    lastSyncedAt: 0,
  };
}

async function loadEnv(): Promise<Record<string, string>> {
  const explicit = process.env.VAULTBOX_E2E_ENV_FILE;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join(repoRoot, ".env.e2e"), path.join(repoRoot, ".env")];
  const loaded = { ...process.env } as Record<string, string>;

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      Object.assign(loaded, parseEnv(raw));
      return loaded;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(
    [
      "Missing E2E environment file.",
      "",
      "Run npm run dropbox:token to create .env.e2e, then run npm run test:e2e.",
    ].join("\n"),
  );
}

function parseEnv(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function getConfig(env: Record<string, string>): E2EConfig {
  if (!env.VAULTBOX_E2E_DROPBOX_REFRESH_TOKEN) {
    throw new Error("Missing E2E env value: VAULTBOX_E2E_DROPBOX_REFRESH_TOKEN");
  }

  return {
    appKey: env.VAULTBOX_E2E_DROPBOX_APP_KEY || DEFAULT_APP_KEY,
    refreshToken: env.VAULTBOX_E2E_DROPBOX_REFRESH_TOKEN,
    testRoot: normalizeDropboxPath(env.VAULTBOX_E2E_DROPBOX_TEST_ROOT || "/Vaultbox E2E"),
    keepArtifacts: env.VAULTBOX_E2E_KEEP_ARTIFACTS === "true",
  };
}

interface E2EConfig {
  appKey: string;
  refreshToken: string;
  testRoot: string;
  keepArtifacts: boolean;
}

function joinDropboxPath(...parts: string[]): string {
  return normalizeDropboxPath(parts.filter(Boolean).join("/"));
}

function parentDropboxPath(filePath: string): string {
  return normalizeDropboxPath(filePath.split("/").slice(0, -1).join("/"));
}

function bytes(value: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(value);
  return cloneBuffer(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
}

function binaryStringToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function bufferToBinaryString(buffer: ArrayBuffer): string {
  let result = "";
  for (const byte of new Uint8Array(buffer)) {
    result += String.fromCharCode(byte);
  }
  return result;
}

function cloneBuffer(buffer: ArrayBuffer): ArrayBuffer {
  return buffer.slice(0);
}
