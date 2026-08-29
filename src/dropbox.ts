import { requestUrl } from "obsidian";
import type {
  DropboxFileMetadata,
  DropboxFolderMetadata,
  DropboxListResult,
  DropboxMetadata,
} from "./types";

const API_URL = "https://api.dropboxapi.com/2";
const CONTENT_URL = "https://content.dropboxapi.com/2";
const MAX_UPLOAD_RETRIES = 8;

export interface DropboxTokenProvider {
  getAccessToken(): Promise<string>;
}

export class DropboxClient {
  constructor(private readonly tokenProvider: DropboxTokenProvider) {}

  async listFolder(path: string, options: { recursive?: boolean } = {}): Promise<DropboxListResult> {
    const result = await this.rpc<{ entries: unknown[]; cursor: string; has_more: boolean }>(
      "/files/list_folder",
      {
        path,
        recursive: options.recursive ?? false,
        include_deleted: false,
        include_has_explicit_shared_members: false,
        include_mounted_folders: true,
        include_non_downloadable_files: false,
      },
    );

    return normalizeListResult(result);
  }

  async listFolderContinue(cursor: string): Promise<DropboxListResult> {
    const result = await this.rpc<{ entries: unknown[]; cursor: string; has_more: boolean }>(
      "/files/list_folder/continue",
      { cursor },
    );

    return normalizeListResult(result);
  }

  async listAllFiles(path: string): Promise<Map<string, DropboxFileMetadata>> {
    const files = new Map<string, DropboxFileMetadata>();
    let result = await this.listFolder(path, { recursive: true });

    while (true) {
      for (const entry of result.entries) {
        if (entry.tag === "file") {
          files.set(entry.pathLower, entry);
        }
      }

      if (!result.hasMore) {
        return files;
      }

      result = await this.listFolderContinue(result.cursor);
    }
  }

  async listFolders(path: string): Promise<DropboxFolderMetadata[]> {
    const folders: DropboxFolderMetadata[] = [];
    let result = await this.listFolder(path);

    while (true) {
      for (const entry of result.entries) {
        if (entry.tag === "folder") {
          folders.push(entry);
        }
      }

      if (!result.hasMore) {
        return folders.sort((first, second) => first.name.localeCompare(second.name));
      }

      result = await this.listFolderContinue(result.cursor);
    }
  }

  async createFolder(path: string): Promise<void> {
    try {
      await this.rpc<unknown>("/files/create_folder_v2", {
        path,
        autorename: false,
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("conflict")) {
        throw error;
      }

      const metadata = await this.getMetadata(path);
      if (metadata.tag !== "folder") {
        throw error;
      }
    }
  }

  async download(path: string): Promise<ArrayBuffer> {
    return this.content<ArrayBuffer>("/files/download", { path }, undefined, "arrayBuffer");
  }

  async upload(args: {
    path: string;
    content: ArrayBuffer;
    rev?: string;
  }): Promise<DropboxFileMetadata> {
    const mode = args.rev ? { ".tag": "update", update: args.rev } : { ".tag": "add" };
    const result = await this.content<unknown>(
      "/files/upload",
      {
        path: args.path,
        mode,
        autorename: false,
        mute: false,
        strict_conflict: true,
      },
      args.content,
      "json",
      { maxRetries: MAX_UPLOAD_RETRIES },
    );

    return normalizeMetadata(result) as DropboxFileMetadata;
  }

  async delete(path: string): Promise<DropboxMetadata> {
    const result = await this.rpc<unknown>("/files/delete_v2", { path });
    return normalizeMetadata((result as { metadata: unknown }).metadata);
  }

  async getMetadata(path: string): Promise<DropboxMetadata> {
    const result = await this.rpc<unknown>("/files/get_metadata", {
      path,
      include_deleted: false,
      include_media_info: false,
    });

    return normalizeMetadata(result);
  }

  private async rpc<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await requestUrl({
      url: `${API_URL}${endpoint}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.tokenProvider.getAccessToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Dropbox ${endpoint} failed with ${response.status}: ${response.text}`);
    }

    return response.json as T;
  }

  private async content<T>(
    endpoint: string,
    args: unknown,
    body?: ArrayBuffer,
    responseType: "json" | "arrayBuffer" = "json",
    options: { maxRetries?: number } = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 0;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await requestUrl({
        url: `${CONTENT_URL}${endpoint}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.tokenProvider.getAccessToken()}`,
          "Content-Type": body ? "application/octet-stream" : "",
          "Dropbox-API-Arg": encodeDropboxApiArg(args),
        },
        body,
        throw: false,
      });

      if (response.status >= 200 && response.status < 300) {
        if (responseType === "arrayBuffer") {
          return response.arrayBuffer as T;
        }

        return response.json as T;
      }

      if (attempt < maxRetries && isRetryableDropboxResponse(response)) {
        await delay(getRetryDelayMs(response, attempt));
        continue;
      }

      throw new Error(`Dropbox ${endpoint} failed with ${response.status}: ${response.text}`);
    }

    throw new Error(`Dropbox ${endpoint} failed after retrying.`);
  }
}

export function encodeDropboxApiArg(args: unknown): string {
  return JSON.stringify(args).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function normalizeDropboxPath(path: string): string {
  const trimmed = path.trim();

  if (!trimmed || trimmed === "/") {
    return "";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function normalizeListResult(result: {
  entries: unknown[];
  cursor: string;
  has_more: boolean;
}): DropboxListResult {
  return {
    entries: result.entries.map(normalizeMetadata),
    cursor: result.cursor,
    hasMore: result.has_more,
  };
}

function normalizeMetadata(entry: unknown): DropboxMetadata {
  const tag = getStringProperty(entry, ".tag") ?? inferMetadataTag(entry);

  if (tag === "file") {
    return {
      tag: "file",
      name: getStringProperty(entry, "name") ?? "",
      pathDisplay: getStringProperty(entry, "path_display") ?? "",
      pathLower: getStringProperty(entry, "path_lower") ?? "",
      id: getStringProperty(entry, "id") ?? "",
      clientModified: getStringProperty(entry, "client_modified") ?? "",
      serverModified: getStringProperty(entry, "server_modified") ?? "",
      rev: getStringProperty(entry, "rev") ?? "",
      size: getNumberProperty(entry, "size") ?? 0,
      contentHash: getStringProperty(entry, "content_hash") ?? "",
    };
  }

  if (tag === "folder") {
    return {
      tag: "folder",
      name: getStringProperty(entry, "name") ?? "",
      pathDisplay: getStringProperty(entry, "path_display") ?? "",
      pathLower: getStringProperty(entry, "path_lower") ?? "",
      id: getStringProperty(entry, "id") ?? "",
    };
  }

  throw new Error(`Unsupported Dropbox metadata tag: ${tag ?? "missing"}`);
}

function inferMetadataTag(entry: unknown): "file" | undefined {
  if (getStringProperty(entry, "rev") !== null || getStringProperty(entry, "content_hash") !== null) {
    return "file";
  }

  return undefined;
}

function isRetryableDropboxResponse(response: { status: number; text: string; json: unknown }): boolean {
  if (response.status !== 429) {
    return false;
  }

  const errorSummary = getDropboxErrorSummary(response);
  return errorSummary.includes("too_many_write_operations") || errorSummary.includes("too_many_requests");
}

function getDropboxErrorSummary(response: { text: string; json: unknown }): string {
  const jsonSummary = getStringProperty(response.json, "error_summary");
  if (jsonSummary) {
    return jsonSummary;
  }

  try {
    const parsed = JSON.parse(response.text) as unknown;
    return getStringProperty(parsed, "error_summary") ?? response.text;
  } catch {
    return response.text;
  }
}

function getRetryDelayMs(
  response: { headers: Record<string, string>; text: string; json: unknown },
  attempt: number,
): number {
  const retryAfter = getRetryAfterSeconds(response);
  if (retryAfter !== null) {
    return Math.max(0, retryAfter * 1000);
  }

  return Math.min(1000 * 2 ** attempt, 8000);
}

function getRetryAfterSeconds(response: {
  headers: Record<string, string>;
  text: string;
  json: unknown;
}): number | null {
  const headerValue = getHeader(response.headers, "retry-after");
  const headerSeconds = parseRetryAfter(headerValue);
  if (headerSeconds !== null) {
    return headerSeconds;
  }

  const jsonRetryAfter = getNumberProperty(response.json, "retry_after");
  if (jsonRetryAfter !== null) {
    return jsonRetryAfter;
  }

  const nestedRetryAfter = getNumberProperty(getObjectProperty(response.json, "error"), "retry_after");
  if (nestedRetryAfter !== null) {
    return nestedRetryAfter;
  }

  try {
    const parsed = JSON.parse(response.text) as unknown;
    return getNumberProperty(getObjectProperty(parsed, "error"), "retry_after") ?? getNumberProperty(parsed, "retry_after");
  } catch {
    return null;
  }
}

function getHeader(headers: Record<string, string>, name: string): string | null {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return match?.[1] ?? null;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds;
  }

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }

  return null;
}

function getStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : null;
}

function getNumberProperty(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const property = (value as Record<string, unknown>)[key];
  return typeof property === "number" && Number.isFinite(property) ? property : null;
}

function getObjectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return null;
  }

  const property = (value as Record<string, unknown>)[key];
  return property && typeof property === "object" ? property : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
