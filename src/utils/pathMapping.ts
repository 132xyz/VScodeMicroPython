/**
 * Path Mapping Utilities - 路径映射工具
 *
 * 提供本地路径与设备路径之间的映射功能。
 * 从 mpremote.ts 迁移并优化。
 */

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

const MPY_WORKBENCH_DIR = ".mpy-workbench";
const CONFIG_FILE = "config.json";

/**
 * 获取工作区的有效设备根目录
 *
 * 当 rootPath 为 '/' 时，使用此函数获取工作区特定的设备根目录，
 * 避免直接使用设备根目录 '/'。
 *
 * @returns 设备根目录路径（如 /mpy_abc123）
 */
export function getEffectiveDeviceRoot(): string {
    try {
        // 允许测试或环境变量覆盖设备根目录
        const envOverride = process.env.MPY_DEVICE_ROOT;
        if (
            envOverride &&
            typeof envOverride === "string" &&
            envOverride.trim().length > 0
        ) {
            return envOverride.startsWith("/")
                ? envOverride
                : `/${envOverride}`;
        }

        const ws = vscode.workspace.workspaceFolders?.[0];
        if (!ws) {
            // 没有工作区 - 返回临时设备目录名以避免使用 '/'
            const name = `mpy_${Math.random().toString(16).slice(2, 10)}`;
            return `/${name}`;
        }

        const wsPath = ws.uri.fsPath;
        const workbenchDir = path.join(wsPath, MPY_WORKBENCH_DIR);
        const cfgPath = path.join(workbenchDir, CONFIG_FILE);

        try {
            if (fs.existsSync(cfgPath)) {
                const txt = fs.readFileSync(cfgPath, "utf8");
                const parsed = JSON.parse(txt || "{}");
                if (
                    parsed &&
                    typeof parsed.deviceRoot === "string" &&
                    parsed.deviceRoot.trim().length > 0
                ) {
                    return parsed.deviceRoot;
                }
            }
        } catch (err) {
            console.warn(
                "[pathMapping] getEffectiveDeviceRoot: failed reading config",
                err
            );
        }

        // 创建确定性的随机名称并持久化
        const rand = crypto.randomBytes(4).toString("hex");
        const name = `mpy_${rand}`;
        const deviceRoot = `/${name}`;

        try {
            if (!fs.existsSync(workbenchDir)) {
                fs.mkdirSync(workbenchDir, { recursive: true });
            }
            const cfg = fs.existsSync(cfgPath)
                ? JSON.parse(fs.readFileSync(cfgPath, "utf8") || "{}")
                : {};
            cfg.deviceRoot = deviceRoot;
            fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
        } catch (err) {
            console.warn(
                "[pathMapping] getEffectiveDeviceRoot: failed writing config",
                err
            );
        }

        return deviceRoot;
    } catch (err) {
        // 最终回退：返回随机名称但不持久化
        const name = `mpy_${Math.random().toString(16).slice(2, 10)}`;
        return `/${name}`;
    }
}

/**
 * 将本地相对路径映射到设备路径
 *
 * @param localRel - 本地相对路径（如 "src/main.py"）
 * @param rootPath - 设备根路径配置（如 "/" 或 "/project"）
 * @returns 设备路径（如 "/mpy_xxx/src/main.py" 或 "/project/src/main.py"）
 *
 * @example
 * ```typescript
 * toDevicePath("main.py", "/") // => "/mpy_xxx/main.py" (使用工作区设备根)
 * toDevicePath("src/app.py", "/project") // => "/project/src/app.py"
 * toDevicePath("", "/project") // => "/project"
 * ```
 */
export function toDevicePath(localRel: string, rootPath: string): string {
    const normLocal = localRel ? localRel.replace(/^\/+/, "") : "";
    let normRoot = (rootPath || "/").replace(/\/$/, "");

    // 当 rootPath 为 "/" 时，使用工作区特定的设备根目录
    if (normRoot === "/" || normRoot === "") {
        normRoot = getEffectiveDeviceRoot();
    }

    return normLocal ? `${normRoot}/${normLocal}` : `${normRoot}`;
}

/**
 * 将设备路径映射到本地相对路径
 *
 * @param devicePath - 设备路径（如 "/mpy_xxx/main.py" 或 "/project/main.py"）
 * @param rootPath - 设备根路径配置（如 "/" 或 "/project"）
 * @returns 本地相对路径，如果是根目录本身返回 null，如果路径在配置的根目录之外也返回 null
 *
 * @example
 * ```typescript
 * toLocalRelative("/mpy_xxx/main.py", "/") // => "main.py" (工作区设备根下)
 * toLocalRelative("/project/src/app.py", "/project") // => "src/app.py"
 * toLocalRelative("/other/file.py", "/project") // => null (outside root)
 * toLocalRelative("/mpy_xxx", "/") // => null (root itself)
 * ```
 */
export function toLocalRelative(
    devicePath: string,
    rootPath: string
): string | null {
    let normRoot = (rootPath || "/").replace(/\/$/, "");

    // 当 rootPath 为 "/" 时，使用工作区特定的设备根目录
    if (normRoot === "/" || normRoot === "") {
        normRoot = getEffectiveDeviceRoot();
    }

    const rootNoSlash = normRoot.replace(/^\/+/, "");
    const dp = devicePath.replace(/^\/+/, "");

    // 设备路径等于根路径 - 返回 null（这是根目录本身）
    if (dp === rootNoSlash) {
        return null;
    }

    // 设备路径在根路径下
    if (dp.startsWith(rootNoSlash + "/")) {
        return dp.slice(rootNoSlash.length + 1);
    }

    // 设备路径在配置的根目录之外
    return null;
}

/**
 * 规范化串口连接字符串
 *
 * @param connect - 连接字符串（如 "serial://COM3" 或 "COM3"）
 * @returns 规范化的端口路径
 */
export function normalizeConnect(connect: string): string {
    if (connect.startsWith("serial://")) {
        return connect.replace(/^serial:\/\//, "");
    }
    if (connect.startsWith("serial:/")) {
        return connect.replace(/^serial:\//, "");
    }

    // macOS: 添加 /dev/ 前缀
    if (connect.startsWith("cu.") && !connect.startsWith("/dev/")) {
        return `/dev/${connect}`;
    }

    return connect;
}

/**
 * 获取当前配置的串口
 *
 * @returns 串口路径，如果是 "auto" 则返回 undefined
 */
export function getConfiguredPort(): string | undefined {
    const config = vscode.workspace.getConfiguration("microPythonWorkBench");
    const connect = config.get<string>("connect");

    if (connect && connect !== "auto") {
        return normalizeConnect(connect);
    }

    return undefined;
}

/**
 * 获取配置的设备根路径
 *
 * @returns 根路径配置值，默认为 "/"
 */
export function getConfiguredRootPath(): string {
    const config = vscode.workspace.getConfiguration("microPythonWorkBench");
    return config.get<string>("rootPath", "/");
}
