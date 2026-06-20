import * as net from "node:net";
import { EventEmitter } from "node:events";
import {
  SerialManagerEndpoint,
  SerialManagerEvent,
  SerialManagerRpcError,
} from "./serialManagerTypes";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

export class SerialManagerRequestError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(error: SerialManagerRpcError) {
    super(error.message || "serial manager request failed");
    this.code = error.code || "error";
    this.details = error.details;
  }
}

export class SerialManagerClient extends EventEmitter {
  private socket?: net.Socket;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly endpoint: SerialManagerEndpoint) {
    super();
  }

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  connect(timeoutMs = 5000): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.endpoint.host, port: this.endpoint.port });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`serial manager connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };

      socket.setEncoding("utf8");
      socket.on("connect", () => {
        this.socket = socket;
        finish(resolve);
      });
      socket.on("data", chunk => this.handleData(String(chunk)));
      socket.on("error", error => {
        finish(() => reject(error));
        this.rejectAll(error);
      });
      socket.on("close", () => {
        if (this.socket === socket) this.socket = undefined;
        this.rejectAll(new Error("serial manager connection closed"));
        this.emit("close");
      });
    });
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30000,
  ): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket) throw new Error("serial manager client is not connected");
    const id = String(this.nextId++);
    const payload = JSON.stringify({ id, token: this.endpoint.token, method, params }) + "\n";

    return await new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`serial manager request '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs)
        : undefined;
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      socket.write(payload, "utf8", error => {
        if (!error) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending?.timer) clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  dispose(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.rejectAll(new Error("serial manager client disposed"));
    if (socket && !socket.destroyed) socket.destroy();
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let payload: any;
    try {
      payload = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error(`invalid serial manager JSON: ${line}`));
      return;
    }

    if (typeof payload.event === "string") {
      this.emit("event", { event: payload.event, payload: payload.payload || {} } as SerialManagerEvent);
      this.emit(payload.event, payload.payload || {});
      return;
    }

    const id = String(payload.id ?? "");
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (payload.ok) {
      pending.resolve(payload.result);
      return;
    }
    pending.reject(new SerialManagerRequestError(payload.error || { code: "error", message: "request failed" }));
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
