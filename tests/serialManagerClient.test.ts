import * as net from "node:net";
import { SerialManagerClient, SerialManagerRequestError } from "../src/board/serialManagerClient";

describe("SerialManagerClient", () => {
  test("calls manager and emits events", async () => {
    const server = net.createServer(socket => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const request = JSON.parse(line);
          socket.write(JSON.stringify({ event: "stdout", payload: { text: "hello" } }) + "\n");
          socket.write(JSON.stringify({ id: request.id, ok: true, result: { pong: true } }) + "\n");
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as net.AddressInfo;
    const client = new SerialManagerClient({ host: "127.0.0.1", port: address.port, token: "tok" });
    const events: unknown[] = [];
    client.on("stdout", payload => events.push(payload));

    const result = await client.call("manager.ping", {}, 1000);
    client.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));

    expect(result).toEqual({ pong: true });
    expect(events).toEqual([{ text: "hello" }]);
  });

  test("rejects structured manager errors", async () => {
    const server = net.createServer(socket => {
      socket.on("data", chunk => {
        const request = JSON.parse(String(chunk).trim());
        socket.write(JSON.stringify({ id: request.id, ok: false, error: { code: "device", message: "boom" } }) + "\n");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as net.AddressInfo;
    const client = new SerialManagerClient({ host: "127.0.0.1", port: address.port, token: "tok" });

    await expect(client.call("manager.status", {}, 1000)).rejects.toBeInstanceOf(SerialManagerRequestError);
    client.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
});
