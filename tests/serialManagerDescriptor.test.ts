jest.unmock("fs");
jest.unmock("node:fs");
jest.unmock("path");
jest.unmock("node:path");

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getSerialManagerDescriptorPath,
  readSerialManagerDescriptor,
  removeSerialManagerDescriptor,
  writeSerialManagerDescriptor,
} from "../src/board/serialManagerDescriptor";
import { SerialManagerDescriptor } from "../src/board/serialManagerTypes";

describe("serial manager descriptor", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mpy-manager-"));
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  test("writes the workspace descriptor atomically", async () => {
    const descriptorPath = getSerialManagerDescriptorPath(root);
    const descriptor: SerialManagerDescriptor = {
      schemaVersion: 1,
      protocolVersion: 1,
      managerInstanceId: "instance-1",
      extensionVersion: "0.4.30",
      device: "COM7",
      host: "127.0.0.1",
      port: 50123,
      token: "secret",
      managerPid: 123,
      scriptPath: "/extension/scripts/mpyrepl/__main__.py",
      createdAt: "2026-07-22T00:00:00.000Z",
    };

    await writeSerialManagerDescriptor(descriptorPath, descriptor);

    expect(JSON.parse(await fs.promises.readFile(descriptorPath, "utf8"))).toEqual(descriptor);
    expect(await readSerialManagerDescriptor(descriptorPath)).toEqual(descriptor);
    expect((await fs.promises.readdir(path.dirname(descriptorPath))).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("only removes the descriptor owned by the expected token", async () => {
    const descriptorPath = getSerialManagerDescriptorPath(root);
    const descriptor = {
      schemaVersion: 1,
      protocolVersion: 1,
      managerInstanceId: "instance-1",
      extensionVersion: "0.4.30",
      device: "COM7",
      host: "127.0.0.1",
      port: 50123,
      token: "current",
      scriptPath: "manager.py",
      createdAt: "now",
    };
    await writeSerialManagerDescriptor(descriptorPath, descriptor);

    await removeSerialManagerDescriptor(descriptorPath, "stale");
    expect(fs.existsSync(descriptorPath)).toBe(true);
    await removeSerialManagerDescriptor(descriptorPath, "current");
    expect(fs.existsSync(descriptorPath)).toBe(false);
  });
});
