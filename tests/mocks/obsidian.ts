export class Notice {
  static messages: string[] = [];

  constructor(message: string) {
    Notice.messages.push(message);
  }

  setMessage(_message: string): void {}

  hide(): void {}
}

type RequestUrl = (request: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}) => Promise<{
  status: number;
  text: string;
  arrayBuffer?: ArrayBuffer;
  json: unknown;
  headers: Record<string, string>;
}>;

let requestUrlMock: RequestUrl | null = null;

export function setRequestUrlMock(mock: RequestUrl | null): void {
  requestUrlMock = mock;
}

export async function requestUrl(request: Parameters<RequestUrl>[0]): Promise<Awaited<ReturnType<RequestUrl>>> {
  if (!requestUrlMock) {
    throw new Error("requestUrl is not available in tests.");
  }

  return requestUrlMock(request);
}

export class Modal {
  constructor(readonly app?: unknown) {}
  open(): void {}
  close(): void {}
}

export class DropdownComponent {}

export class Plugin {
  app: unknown;
  manifest: unknown;

  constructor(app?: unknown, manifest?: unknown) {
    this.app = app;
    this.manifest = manifest;
  }
}
export class PluginSettingTab {}
export class Setting {}
export class App {}

export function addIcon(): void {}
