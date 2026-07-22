import * as fs from "node:fs";
import * as path from "node:path";
import { SerialManagerDescriptor } from "./serialManagerTypes";

export const SERIAL_MANAGER_DESCRIPTOR_RELATIVE_PATH = path.join(
  ".mpy-workbench",
  "serial-manager.json",
);

export function getSerialManagerDescriptorPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, SERIAL_MANAGER_DESCRIPTOR_RELATIVE_PATH);
}

export async function readSerialManagerDescriptor(
  descriptorPath: string,
): Promise<SerialManagerDescriptor | undefined> {
  try {
    const value = JSON.parse(await fs.promises.readFile(descriptorPath, "utf8"));
    if (!value || typeof value !== "object") return undefined;
    return value as SerialManagerDescriptor;
  } catch {
    return undefined;
  }
}

export async function writeSerialManagerDescriptor(
  descriptorPath: string,
  descriptor: SerialManagerDescriptor,
): Promise<void> {
  const directory = path.dirname(descriptorPath);
  await fs.promises.mkdir(directory, { recursive: true });
  const temporaryPath = `${descriptorPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(
      temporaryPath,
      `${JSON.stringify(descriptor, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await fs.promises.rename(temporaryPath, descriptorPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeSerialManagerDescriptor(
  descriptorPath: string | undefined,
  expectedToken: string,
): Promise<void> {
  if (!descriptorPath) return;
  const descriptor = await readSerialManagerDescriptor(descriptorPath);
  if (!descriptor) return;
  if (descriptor.token !== expectedToken) return;
  await fs.promises.rm(descriptorPath, { force: true }).catch(() => undefined);
}
