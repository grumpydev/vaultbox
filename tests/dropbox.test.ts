import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRequestUrlMock } from "./mocks/obsidian";
import { DropboxClient, encodeDropboxApiArg, normalizeDropboxPath } from "../src/dropbox";

describe("DropboxClient", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { setTimeout });
  });

  afterEach(() => {
    setRequestUrlMock(null);
    vi.unstubAllGlobals();
  });

  it("normalizes Dropbox folder paths", () => {
    expect(normalizeDropboxPath("")).toBe("");
    expect(normalizeDropboxPath("/")).toBe("");
    expect(normalizeDropboxPath(" Vaults/Personal/ ")).toBe("/Vaults/Personal");
    expect(normalizeDropboxPath("//Vaults/Personal//")).toBe("/Vaults/Personal");
  });

  it("lists files and normalizes Dropbox metadata", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      text: "",
      json: {
        entries: [
          {
            ".tag": "folder",
            name: "Notes",
            path_display: "/Notes",
            path_lower: "/notes",
            id: "id:folder",
          },
          {
            ".tag": "file",
            name: "A.md",
            path_display: "/Notes/A.md",
            path_lower: "/notes/a.md",
            id: "id:file",
            client_modified: "2026-01-01T00:00:00Z",
            server_modified: "2026-01-01T00:00:01Z",
            rev: "rev-a",
            size: 12,
            content_hash: "hash-a",
          },
        ],
        cursor: "cursor",
        has_more: false,
      },
      headers: {},
    }));
    setRequestUrlMock(request);

    const client = new DropboxClient({ getAccessToken: async () => "token" });
    const files = await client.listAllFiles("/Notes");

    expect(files.get("/notes/a.md")).toEqual({
      tag: "file",
      name: "A.md",
      pathDisplay: "/Notes/A.md",
      pathLower: "/notes/a.md",
      id: "id:file",
      clientModified: "2026-01-01T00:00:00Z",
      serverModified: "2026-01-01T00:00:01Z",
      rev: "rev-a",
      size: 12,
      contentHash: "hash-a",
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.dropboxapi.com/2/files/list_folder",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
        }),
      }),
    );
  });

  it("lists immediate Dropbox folders for picker navigation", async () => {
    setRequestUrlMock(async () => ({
      status: 200,
      text: "",
      json: {
        entries: [
          {
            ".tag": "file",
            name: "A.md",
            path_display: "/A.md",
            path_lower: "/a.md",
            id: "id:file",
            rev: "rev-a",
            content_hash: "hash-a",
          },
          {
            ".tag": "folder",
            name: "Vaults",
            path_display: "/Vaults",
            path_lower: "/vaults",
            id: "id:vaults",
          },
        ],
        cursor: "cursor",
        has_more: false,
      },
      headers: {},
    }));

    const client = new DropboxClient({ getAccessToken: async () => "token" });
    await expect(client.listFolders("")).resolves.toEqual([
      expect.objectContaining({
        tag: "folder",
        pathDisplay: "/Vaults",
      }),
    ]);
  });

  it("continues Dropbox folder listings when the picker result is paginated", async () => {
    const request = vi.fn(async (args: { url: string }) => {
      if (args.url.endsWith("/files/list_folder/continue")) {
        return {
          status: 200,
          text: "",
          json: {
            entries: [
              {
                ".tag": "folder",
                name: "movie-factory",
                path_display: "/movie-factory",
                path_lower: "/movie-factory",
                id: "id:movie-factory",
              },
              {
                ".tag": "file",
                name: "A.md",
                path_display: "/A.md",
                path_lower: "/a.md",
                id: "id:file",
                rev: "rev-a",
                content_hash: "hash-a",
              },
            ],
            cursor: "cursor-2",
            has_more: false,
          },
          headers: {},
        };
      }

      return {
        status: 200,
        text: "",
        json: {
          entries: [
            {
              ".tag": "folder",
              name: "Archive",
              path_display: "/Archive",
              path_lower: "/archive",
              id: "id:archive",
            },
          ],
          cursor: "cursor-1",
          has_more: true,
        },
        headers: {},
      };
    });
    setRequestUrlMock(request);

    const client = new DropboxClient({ getAccessToken: async () => "token" });
    await expect(client.listFolders("")).resolves.toEqual([
      expect.objectContaining({ pathDisplay: "/Archive" }),
      expect.objectContaining({ pathDisplay: "/movie-factory" }),
    ]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        url: "https://api.dropboxapi.com/2/files/list_folder/continue",
      }),
    );
  });

  it("uses update mode with rev for guarded uploads", async () => {
    const content = new Uint8Array([0, 195, 169, 255]).buffer;
    const request = vi.fn(async () => ({
      status: 200,
      text: "",
      json: {
        ".tag": "file",
        name: "A.md",
        path_display: "/A.md",
        path_lower: "/a.md",
        id: "id:file",
        client_modified: "2026-01-01T00:00:00Z",
        server_modified: "2026-01-01T00:00:01Z",
        rev: "rev-b",
        size: 1,
        content_hash: "hash-b",
      },
      headers: {},
    }));
    setRequestUrlMock(request);

    const client = new DropboxClient({ getAccessToken: async () => "token" });
    await client.upload({
      path: "/A.md",
      rev: "rev-a",
      content,
    });

    const firstCall = request.mock.calls[0] as Array<{ body?: ArrayBuffer; headers?: Record<string, string> }> | undefined;
    expect(firstCall).toBeDefined();
    const arg = JSON.parse(String(firstCall?.[0].headers?.["Dropbox-API-Arg"]));
    expect(arg.mode).toEqual({ ".tag": "update", update: "rev-a" });
    expect(arg.autorename).toBe(false);
    expect(arg.strict_conflict).toBe(true);
    expect(firstCall?.[0].body).toBe(content);
  });

  it("downloads raw bytes from the response array buffer", async () => {
    const content = new Uint8Array([0, 195, 169, 255]).buffer;
    const request = vi.fn(async () => ({
      status: 200,
      text: "corrupted text fallback",
      arrayBuffer: content,
      json: {},
      headers: {},
    }));
    setRequestUrlMock(request);

    const client = new DropboxClient({ getAccessToken: async () => "token" });
    await expect(client.download("/A.md")).resolves.toBe(content);
  });

  it("escapes non-ASCII characters in Dropbox content API headers", async () => {
    const encoded = encodeDropboxApiArg({ path: "/Notes/Project 🚀.md" });

    expect(encoded).toBe('{"path":"/Notes/Project \\ud83d\\ude80.md"}');
    expect(/^[\x00-\x7f]*$/.test(encoded)).toBe(true);
    expect(JSON.parse(encoded)).toEqual({ path: "/Notes/Project 🚀.md" });
  });

  it("uses ASCII-safe Dropbox API args for downloads with emoji paths", async () => {
    const content = new Uint8Array([1, 2, 3]).buffer;
    const request = vi.fn(async () => ({
      status: 200,
      text: "",
      arrayBuffer: content,
      json: {},
      headers: {},
    }));
    setRequestUrlMock(request);

    const client = new DropboxClient({ getAccessToken: async () => "token" });
    await expect(client.download("/Notes/Project 🚀.md")).resolves.toBe(content);

    const firstCall = request.mock.calls[0] as Array<{ headers?: Record<string, string> }> | undefined;
    const header = String(firstCall?.[0].headers?.["Dropbox-API-Arg"]);
    expect(/^[\x00-\x7f]*$/.test(header)).toBe(true);
    expect(JSON.parse(header)).toEqual({ path: "/Notes/Project 🚀.md" });
  });

  it("lists all files recursively for sync snapshots", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      text: "",
      json: {
        entries: [],
        cursor: "cursor",
        has_more: false,
      },
      headers: {},
    }));
    setRequestUrlMock(request);

    const client = new DropboxClient({ getAccessToken: async () => "token" });
    await client.listAllFiles("/Vault");

    const firstCall = request.mock.calls[0] as Array<{ body?: string }> | undefined;
    expect(firstCall).toBeDefined();
    expect(JSON.parse(String(firstCall?.[0].body))).toMatchObject({
      path: "/Vault",
      recursive: true,
    });
  });

  it("creates Dropbox folders and tolerates existing folder conflicts", async () => {
    const request = vi.fn(async (args) => {
      if (String(args.url).endsWith("/files/create_folder_v2")) {
        return {
          status: 409,
          text: '{"error_summary":"path/conflict/folder/"}',
          json: {},
          headers: {},
        };
      }

      return {
        status: 200,
        text: "",
        json: {
          ".tag": "folder",
          name: "Notes",
          path_display: "/Notes",
          path_lower: "/notes",
          id: "id:folder",
        },
        headers: {},
      };
    });
    setRequestUrlMock(request);

    const client = new DropboxClient({ getAccessToken: async () => "token" });
    await expect(client.createFolder("/Notes")).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("normalizes upload metadata when Dropbox omits the file tag", async () => {
    setRequestUrlMock(async () => ({
      status: 200,
      text: "",
      json: {
        name: "A.md",
        path_display: "/A.md",
        path_lower: "/a.md",
        id: "id:file",
        client_modified: "2026-01-01T00:00:00Z",
        server_modified: "2026-01-01T00:00:01Z",
        rev: "rev-b",
        size: 1,
        content_hash: "hash-b",
      },
      headers: {},
    }));

    const client = new DropboxClient({ getAccessToken: async () => "token" });
    await expect(
      client.upload({
        path: "/A.md",
        content: new Uint8Array([65]).buffer,
      }),
    ).resolves.toMatchObject({
      tag: "file",
      pathLower: "/a.md",
      rev: "rev-b",
      contentHash: "hash-b",
    });
  });

  it("retries Dropbox upload write throttling responses", async () => {
    const request = vi.fn(async () => {
      if (request.mock.calls.length === 1) {
        return {
          status: 429,
          text: '{"error_summary":"too_many_write_operations/..","error":{"reason":{".tag":"too_many_write_operations"},"retry_after":0}}',
          json: {
            error_summary: "too_many_write_operations/..",
            error: {
              reason: { ".tag": "too_many_write_operations" },
              retry_after: 0,
            },
          },
          headers: {},
        };
      }

      return {
        status: 200,
        text: "",
        json: {
          ".tag": "file",
          name: "A.md",
          path_display: "/A.md",
          path_lower: "/a.md",
          id: "id:file",
          client_modified: "2026-01-01T00:00:00Z",
          server_modified: "2026-01-01T00:00:01Z",
          rev: "rev-b",
          size: 1,
          content_hash: "hash-b",
        },
        headers: {},
      };
    });
    setRequestUrlMock(request);

    const client = new DropboxClient({ getAccessToken: async () => "token" });
    await expect(
      client.upload({
        path: "/A.md",
        content: new Uint8Array([65]).buffer,
      }),
    ).resolves.toMatchObject({
      rev: "rev-b",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
