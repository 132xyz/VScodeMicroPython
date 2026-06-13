import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type CustomReplCommand = "interrupt" | "soft-reset" | "interrupt-reset" | "exit" | "exec" | "fs";

export type CustomReplPayload = {
  source?: string;
  label?: string;
  request_id?: string;
  response_file?: string;
  payload?: Record<string, unknown>;
};

export type CustomReplResponse<T = unknown> = {
  request_id?: string;
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
};

function sanitizeForFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

export function getCustomReplControlFile(device: string): string {
  return path.join(os.tmpdir(), "vscodemicropython", `mpyrepl-${sanitizeForFileName(device)}.json`);
}

function getCustomReplResponseFile(device: string, requestId: string): string {
  return path.join(os.tmpdir(), "vscodemicropython", `mpyrepl-${sanitizeForFileName(device)}-${requestId}.response.json`);
}

export async function readCustomReplControlSequence(controlFile: string): Promise<number> {
  try {
    const rawPayload = await fs.promises.readFile(controlFile, "utf8");
    const payload = JSON.parse(rawPayload);
    const sequence = payload?.sequence;
    return typeof sequence === "number" && Number.isFinite(sequence) ? sequence : -1;
  } catch {
    return -1;
  }
}

export function customReplControlFileExists(device: string): boolean {
  try {
    return fs.existsSync(getCustomReplControlFile(device));
  } catch {
    return false;
  }
}

export async function clearCustomReplControlFile(device: string): Promise<void> {
  try {
    await fs.promises.unlink(getCustomReplControlFile(device));
  } catch {
    // ignore
  }
}

export async function sendCustomReplControl(
  device: string,
  command: CustomReplCommand,
  payload: CustomReplPayload = {},
): Promise<void> {
  const controlFile = getCustomReplControlFile(device);
  await fs.promises.mkdir(path.dirname(controlFile), { recursive: true });
  const sequence = (await readCustomReplControlSequence(controlFile)) + 1;
  await fs.promises.writeFile(
    controlFile,
    JSON.stringify({ sequence, command, ...payload }),
    "utf8",
  );
}

function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readResponseFile<T>(responseFile: string): Promise<CustomReplResponse<T> | undefined> {
  try {
    const raw = await fs.promises.readFile(responseFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
      return parsed as CustomReplResponse<T>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function requestCustomReplRpc<T = unknown>(
  device: string,
  command: "fs",
  payload: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<T> {
  const requestId = createRequestId();
  const responseFile = getCustomReplResponseFile(device, requestId);
  try {
    await fs.promises.unlink(responseFile);
  } catch {
    // ignore stale file removal failures
  }

  await sendCustomReplControl(device, command, {
    request_id: requestId,
    response_file: responseFile,
    payload,
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await readResponseFile<T>(responseFile);
    if (response) {
      try {
        await fs.promises.unlink(responseFile);
      } catch {
        // ignore cleanup errors
      }
      if (!response.ok) {
        const error = new Error(response.error || "custom REPL request failed") as Error & { code?: string };
        error.code = response.code;
        throw error;
      }
      return response.data as T;
    }
    await sleep(50);
  }

  throw new Error(`custom REPL request timed out after ${timeoutMs}ms`);
}
