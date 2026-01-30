/**
 * File Tree Cache - 文件树缓存模块
 *
 * 提供设备文件树的缓存功能，减少对设备的重复查询。
 * 使用 DeviceAdapter 作为数据源。
 */

import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

const MPY_WORKBENCH_DIR = ".mpy-workbench";
const TREE_PATHS_FILE = "tree-paths.json";
const CACHE_DURATION_MS = 30000; // 30 秒

/**
 * 文件树节点
 */
export interface TreeNode {
    name: string;
    isDir: boolean;
    children: TreeNode[];
    fullPath: string;
    size?: number;
    mtime?: number;
}

/**
 * 文件条目（简化版）
 */
export interface FileEntry {
    name: string;
    isDir: boolean;
    size?: number;
}

/**
 * 解析的行数据
 */
interface ParsedLine {
    fullPath: string;
    name: string;
    isDir: boolean;
    depth: number;
}

/**
 * 缓存统计信息
 */
export interface CacheStats {
    isValid: boolean;
    age: number;
    itemCount: number;
    lastUpdate: number;
}

/**
 * 文件树缓存类
 *
 * 管理设备文件树的内存缓存和磁盘持久化。
 */
class FileTreeCacheManager {
    private cache: TreeNode | null = null;
    private lastUpdate: number = 0;
    private readonly cacheDuration = CACHE_DURATION_MS;

    /**
     * 获取目录内容
     *
     * @param targetPath - 设备路径（如 "/" 或 "/lib"）
     * @returns 目录条目列表，如果缓存未命中返回 null
     */
    getEntries(targetPath: string): FileEntry[] | null {
        if (!this.cache) {
            return null;
        }

        if (targetPath === "/") {
            return this.cache.children.map((child) => ({
                name: child.name,
                isDir: child.isDir,
                size: child.size,
            }));
        }

        // 查找目标目录节点
        const pathParts = targetPath.split("/").filter((p) => p);
        let currentNode = this.cache;

        for (const part of pathParts) {
            const found = currentNode.children.find((child) => child.name === part);
            if (!found) {
                return null;
            }
            currentNode = found;
        }

        return currentNode.children.map((child) => ({
            name: child.name,
            isDir: child.isDir,
            size: child.size,
        }));
    }

    /**
     * 检查缓存是否有效
     */
    isValid(): boolean {
        if (!this.cache) {
            return false;
        }
        return Date.now() - this.lastUpdate < this.cacheDuration;
    }

    /**
     * 清除缓存
     */
    clear(): void {
        this.cache = null;
        this.lastUpdate = 0;
        console.log("[FileTreeCache] Cache cleared");
    }

    /**
     * 使用条目列表更新缓存
     *
     * @param entries - 从设备获取的文件条目
     * @param rootPath - 根路径
     */
    updateFromEntries(entries: FileEntry[], rootPath: string = "/"): void {
        const root: TreeNode = {
            name: "",
            isDir: true,
            children: [],
            fullPath: "/",
        };

        // 将条目添加到根节点
        for (const entry of entries) {
            root.children.push({
                name: entry.name,
                isDir: entry.isDir,
                children: [],
                fullPath: rootPath === "/" ? `/${entry.name}` : `${rootPath}/${entry.name}`,
                size: entry.size,
            });
        }

        this.cache = root;
        this.lastUpdate = Date.now();
    }

    /**
     * 使用递归文件树更新缓存
     *
     * @param tree - 完整的树结构
     */
    updateFromTree(tree: TreeNode): void {
        this.cache = tree;
        this.lastUpdate = Date.now();
        this.persistToFile();
    }

    /**
     * 在特定路径下添加条目
     *
     * @param parentPath - 父目录路径
     * @param entries - 子条目
     */
    updatePath(parentPath: string, entries: FileEntry[]): void {
        if (!this.cache) {
            // 创建新缓存
            this.updateFromEntries(entries, parentPath);
            return;
        }

        // 查找父节点
        const node = this.findNode(parentPath);
        if (node) {
            node.children = entries.map((entry) => ({
                name: entry.name,
                isDir: entry.isDir,
                children: [],
                fullPath:
                    parentPath === "/" ? `/${entry.name}` : `${parentPath}/${entry.name}`,
                size: entry.size,
            }));
            this.lastUpdate = Date.now();
        }
    }

    /**
     * 从缓存中移除特定路径
     *
     * @param targetPath - 要移除的路径
     */
    removePath(targetPath: string): void {
        if (!this.cache || targetPath === "/") {
            return;
        }

        const pathParts = targetPath.split("/").filter((p) => p);
        if (pathParts.length === 0) {
            return;
        }

        const parentPath =
            pathParts.length === 1
                ? "/"
                : "/" + pathParts.slice(0, -1).join("/");
        const targetName = pathParts[pathParts.length - 1];

        const parentNode = this.findNode(parentPath);
        if (parentNode) {
            const index = parentNode.children.findIndex(
                (child) => child.name === targetName
            );
            if (index !== -1) {
                parentNode.children.splice(index, 1);
            }
        }
    }

    /**
     * 在缓存中添加新路径
     *
     * @param targetPath - 新路径
     * @param isDir - 是否为目录
     */
    addPath(targetPath: string, isDir: boolean): void {
        if (!this.cache || targetPath === "/") {
            return;
        }

        const pathParts = targetPath.split("/").filter((p) => p);
        if (pathParts.length === 0) {
            return;
        }

        const parentPath =
            pathParts.length === 1
                ? "/"
                : "/" + pathParts.slice(0, -1).join("/");
        const targetName = pathParts[pathParts.length - 1];

        const parentNode = this.findNode(parentPath);
        if (parentNode) {
            // 检查是否已存在
            const exists = parentNode.children.some(
                (child) => child.name === targetName
            );
            if (!exists) {
                parentNode.children.push({
                    name: targetName,
                    isDir,
                    children: [],
                    fullPath: targetPath,
                });
            }
        }
    }

    /**
     * 获取缓存统计信息
     */
    getStats(): CacheStats {
        const isValid = this.isValid();
        const age = Date.now() - this.lastUpdate;
        let itemCount = 0;

        if (this.cache) {
            const countNodes = (node: TreeNode): number => {
                let count = 1;
                for (const child of node.children) {
                    count += countNodes(child);
                }
                return count;
            };
            itemCount = countNodes(this.cache);
        }

        return {
            isValid,
            age,
            itemCount,
            lastUpdate: this.lastUpdate,
        };
    }

    /**
     * 尝试从磁盘加载缓存
     *
     * @returns 是否成功加载
     */
    loadFromFile(): boolean {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                return false;
            }

            const filePath = path.join(
                workspaceFolder.uri.fsPath,
                MPY_WORKBENCH_DIR,
                TREE_PATHS_FILE
            );

            if (!fs.existsSync(filePath)) {
                return false;
            }

            const stats = fs.statSync(filePath);
            const fileAge = Date.now() - stats.mtime.getTime();

            // 只加载 30 秒内的缓存文件
            if (fileAge >= this.cacheDuration) {
                return false;
            }

            const cachedData = JSON.parse(
                fs.readFileSync(filePath, "utf8")
            ) as ParsedLine[];
            const tree = this.buildTreeFromParsedLines(cachedData);

            this.cache = tree;
            this.lastUpdate = Date.now() - fileAge;

            console.log(
                `[FileTreeCache] Loaded ${cachedData.length} items from file cache`
            );
            return true;
        } catch (error) {
            console.warn("[FileTreeCache] Failed to load from file:", error);
            return false;
        }
    }

    /**
     * 持久化缓存到磁盘
     */
    private persistToFile(): void {
        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder || !this.cache) {
                return;
            }

            const workbenchDir = path.join(
                workspaceFolder.uri.fsPath,
                MPY_WORKBENCH_DIR
            );
            const filePath = path.join(workbenchDir, TREE_PATHS_FILE);

            // 确保目录存在
            if (!fs.existsSync(workbenchDir)) {
                fs.mkdirSync(workbenchDir, { recursive: true });
            }

            // 转换为扁平列表
            const flatList = this.flattenTree(this.cache);
            fs.writeFileSync(filePath, JSON.stringify(flatList, null, 2));

            console.log(
                `[FileTreeCache] Saved ${flatList.length} items to file cache`
            );
        } catch (error) {
            console.warn("[FileTreeCache] Failed to persist to file:", error);
        }
    }

    /**
     * 查找节点
     */
    private findNode(targetPath: string): TreeNode | null {
        if (!this.cache) {
            return null;
        }

        if (targetPath === "/") {
            return this.cache;
        }

        const pathParts = targetPath.split("/").filter((p) => p);
        let currentNode = this.cache;

        for (const part of pathParts) {
            const found = currentNode.children.find((child) => child.name === part);
            if (!found) {
                return null;
            }
            currentNode = found;
        }

        return currentNode;
    }

    /**
     * 从解析的行构建树
     */
    private buildTreeFromParsedLines(parsedLines: ParsedLine[]): TreeNode {
        const root: TreeNode = {
            name: "",
            isDir: true,
            children: [],
            fullPath: "/",
        };

        const nodeMap = new Map<string, TreeNode>();
        nodeMap.set("/", root);

        for (const item of parsedLines) {
            const pathParts = item.fullPath.split("/").filter((p) => p);
            const parentPath =
                pathParts.length > 1
                    ? "/" + pathParts.slice(0, -1).join("/")
                    : "/";

            const parentNode = nodeMap.get(parentPath);

            if (parentNode) {
                const newNode: TreeNode = {
                    name: item.name,
                    isDir: item.isDir,
                    children: [],
                    fullPath: item.fullPath,
                };

                parentNode.children.push(newNode);

                if (item.isDir) {
                    nodeMap.set(item.fullPath, newNode);
                }
            }
        }

        return root;
    }

    /**
     * 将树扁平化为列表
     */
    private flattenTree(node: TreeNode, depth: number = 0): ParsedLine[] {
        const result: ParsedLine[] = [];

        for (const child of node.children) {
            result.push({
                fullPath: child.fullPath,
                name: child.name,
                isDir: child.isDir,
                depth,
            });

            if (child.isDir && child.children.length > 0) {
                result.push(...this.flattenTree(child, depth + 1));
            }
        }

        return result;
    }
}

/**
 * 全局文件树缓存实例
 */
export const fileTreeCache = new FileTreeCacheManager();

/**
 * 清除文件树缓存
 * @deprecated 使用 fileTreeCache.clear() 代替
 */
export function clearFileTreeCache(): void {
    fileTreeCache.clear();
}

/**
 * 刷新文件树缓存
 *
 * 注意：此函数需要 DeviceAdapter 实例来获取新数据。
 * 调用者应该先获取数据，然后使用 fileTreeCache.updateFromTree() 更新。
 *
 * @deprecated 直接使用 fileTreeCache 方法
 */
export async function refreshFileTreeCache(): Promise<void> {
    fileTreeCache.clear();
    // 尝试从文件加载
    fileTreeCache.loadFromFile();
    console.log("[FileTreeCache] Cache refreshed (file load attempted)");
}

/**
 * 获取缓存统计信息
 */
export function getFileTreeCacheStats(): CacheStats {
    return fileTreeCache.getStats();
}
