/**
 * Serial Port Service - 串口服务
 *
 * 提供串口枚举和管理功能。
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { SerialPortInfo } from "./deviceAdapter";
import { detectPythonPath, getInternalPythonRoot } from "../python/pythonDetector";
import * as path from "node:path";

const execAsync = promisify(exec);

/**
 * 串口服务类
 */
export class SerialPortService {
    private static instance: SerialPortService | null = null;
    private cachedPorts: SerialPortInfo[] = [];
    private cacheTime = 0;
    private readonly CACHE_TTL = 5000; // 5 秒缓存

    private constructor() {}

    /**
     * 获取单例实例
     */
    public static getInstance(): SerialPortService {
        if (!SerialPortService.instance) {
            SerialPortService.instance = new SerialPortService();
        }
        return SerialPortService.instance;
    }

    /**
     * 列出可用串口
     */
    public async listPorts(forceRefresh = false): Promise<SerialPortInfo[]> {
        // 检查缓存
        if (
            !forceRefresh &&
            this.cachedPorts.length > 0 &&
            Date.now() - this.cacheTime < this.CACHE_TTL
        ) {
            return this.cachedPorts;
        }

        try {
            // 使用 Python 的 serial.tools.list_ports 列出串口
            const ports = await this.listPortsViaPython();
            this.cachedPorts = ports;
            this.cacheTime = Date.now();
            return ports;
        } catch (error) {
            console.error("[SerialPortService] Failed to list ports:", error);
            // 返回缓存（如果有）
            return this.cachedPorts;
        }
    }

    /**
     * 检查端口是否可用
     */
    public async isPortAvailable(port: string): Promise<boolean> {
        const ports = await this.listPorts();
        return ports.some((p) => p.port === port);
    }

    /**
     * 获取端口信息
     */
    public async getPortInfo(port: string): Promise<SerialPortInfo | null> {
        const ports = await this.listPorts();
        return ports.find((p) => p.port === port) || null;
    }

    /**
     * 清除缓存
     */
    public clearCache(): void {
        this.cachedPorts = [];
        this.cacheTime = 0;
    }

    // ========================================================================
    // 私有方法
    // ========================================================================

    private async listPortsViaPython(): Promise<SerialPortInfo[]> {
        const pythonPath = await detectPythonPath();
        if (!pythonPath) {
            throw new Error("Python not found");
        }

        const internalRoot = getInternalPythonRoot();
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PYTHONUTF8: "1",
            PYTHONIOENCODING: "utf-8",
        };

        if (internalRoot) {
            const delim = path.delimiter;
            env.PYTHONPATH = env.PYTHONPATH
                ? `${internalRoot}${delim}${env.PYTHONPATH}`
                : internalRoot;
        }

        const script = `
import json
import sys
try:
    from serial.tools import list_ports
    ports = []
    for port in list_ports.comports():
        ports.append({
            "port": port.device,
            "name": port.description or port.device,
            "vendorId": hex(port.vid) if port.vid else None,
            "productId": hex(port.pid) if port.pid else None,
            "manufacturer": port.manufacturer,
            "serialNumber": port.serial_number,
            "hwid": port.hwid,
        })
    print(json.dumps(ports))
except ImportError:
    print("[]")
except Exception as e:
    print(f"[]", file=sys.stderr)
`;

        try {
            const { stdout } = await execAsync(
                `"${pythonPath}" -c "${script.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
                { env, timeout: 10000 }
            );

            const ports = JSON.parse(stdout.trim());
            return ports.map((p: any) => ({
                port: p.port,
                name: p.name,
                vendorId: p.vendorId,
                productId: p.productId,
                manufacturer: p.manufacturer,
            }));
        } catch (error) {
            console.error(
                "[SerialPortService] Python list_ports failed:",
                error
            );
            // 尝试备用方法
            return this.listPortsFallback();
        }
    }

    private async listPortsFallback(): Promise<SerialPortInfo[]> {
        const ports: SerialPortInfo[] = [];

        if (process.platform === "win32") {
            // Windows: 使用 mode 命令
            try {
                const { stdout } = await execAsync("mode", { timeout: 5000 });
                const matches = stdout.matchAll(/Status for device (COM\d+):/gi);
                for (const match of matches) {
                    ports.push({
                        port: match[1],
                        name: match[1],
                    });
                }
            } catch {
                // 尝试 PowerShell
                try {
                    const { stdout } = await execAsync(
                        'powershell -Command "Get-WMIObject Win32_SerialPort | Select-Object DeviceID, Caption | ConvertTo-Json"',
                        { timeout: 10000 }
                    );
                    const data = JSON.parse(stdout);
                    const items = Array.isArray(data) ? data : [data];
                    for (const item of items) {
                        if (item?.DeviceID) {
                            ports.push({
                                port: item.DeviceID,
                                name: item.Caption || item.DeviceID,
                            });
                        }
                    }
                } catch {
                    // 忽略
                }
            }
        } else if (process.platform === "darwin") {
            // macOS: 列出 /dev/cu.* 和 /dev/tty.*
            try {
                const { stdout } = await execAsync(
                    "ls /dev/cu.* /dev/tty.* 2>/dev/null || true",
                    { timeout: 5000 }
                );
                const devices = stdout.trim().split("\n").filter(Boolean);
                for (const device of devices) {
                    // 过滤掉蓝牙设备
                    if (!device.includes("Bluetooth")) {
                        ports.push({
                            port: device,
                            name: device.split("/").pop() || device,
                        });
                    }
                }
            } catch {
                // 忽略
            }
        } else {
            // Linux: 列出 /dev/ttyUSB* 和 /dev/ttyACM*
            try {
                const { stdout } = await execAsync(
                    "ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true",
                    { timeout: 5000 }
                );
                const devices = stdout.trim().split("\n").filter(Boolean);
                for (const device of devices) {
                    ports.push({
                        port: device,
                        name: device.split("/").pop() || device,
                    });
                }
            } catch {
                // 忽略
            }
        }

        return ports;
    }
}

/**
 * 快捷函数：列出可用串口
 */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
    return SerialPortService.getInstance().listPorts();
}

/**
 * 快捷函数：检查端口是否可用
 */
export async function isPortAvailable(port: string): Promise<boolean> {
    return SerialPortService.getInstance().isPortAvailable(port);
}
