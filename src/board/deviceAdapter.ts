/**
 * Device Adapter Interface - 设备适配器接口
 *
 * 提供与旧 mpremote API 兼容的接口，内部使用新的 mpy_backend 实现。
 * 这是迁移期间的兼容层，允许逐步替换旧代码。
 */

/**
 * 设备信息
 */
export interface BoardInfo {
    /** 设备名称，如 "ESP32-S3" */
    machine: string;
    /** MicroPython 版本 */
    version: string;
    /** 固件构建日期 */
    buildDate?: string;
    /** 芯片 ID */
    chipId?: string;
    /** 闪存大小 (字节) */
    flashSize?: number;
    /** 可用内存 (字节) */
    freeMemory?: number;
    /** 系统名称 (兼容旧 mpremote 格式) */
    sysname?: string;
    /** 设备唯一标识符 (兼容旧 mpremote 格式) */
    id?: string;
}

/**
 * 文件/目录信息
 */
export interface FileEntry {
    /** 文件/目录名称 */
    name: string;
    /** 是否为目录 */
    isDir: boolean;
    /** 文件大小 (字节)，目录为 0 */
    size?: number;
    /** 修改时间戳 */
    mtime?: number;
}

/**
 * 文件状态信息
 */
export interface FileStat {
    /** 文件模式 */
    mode: number;
    /** 文件大小 (字节) */
    size: number;
    /** 是否为目录 */
    isDir: boolean;
    /** 是否只读 */
    isReadonly: boolean;
    /** 修改时间戳 */
    mtime?: number;
}

/**
 * 树状态信息
 */
export interface TreeStat {
    /** 完整路径 */
    path: string;
    /** 是否为目录 */
    isDir: boolean;
    /** 文件大小 */
    size: number;
    /** 修改时间戳 */
    mtime: number;
}

/**
 * 文件大小映射结果
 */
export interface BoardFilesResult {
    /** 文件映射: 路径 -> {大小, 是否目录} */
    files: Map<string, { size: number; isDir: boolean }>;
    /** 目录集合 */
    directories: Set<string>;
}

/**
 * 串口信息
 */
export interface SerialPortInfo {
    /** 端口名称，如 "COM3" 或 "/dev/ttyUSB0" */
    port: string;
    /** 端口描述 */
    name: string;
    /** 设备 VID */
    vendorId?: string;
    /** 设备 PID */
    productId?: string;
    /** 制造商 */
    manufacturer?: string;
}

/**
 * 健康检查结果
 */
export interface HealthCheckResult {
    /** 设备是否健康 */
    healthy: boolean;
    /** 响应时间 (毫秒) */
    responseTime: number;
    /** 错误信息 (如果不健康) */
    error?: string;
}

/**
 * 执行结果
 */
export interface ExecuteResult {
    /** 是否成功 */
    success: boolean;
    /** 标准输出 */
    stdout: string;
    /** 标准错误输出 */
    stderr: string;
    /** 执行时间 (毫秒) */
    executionTime?: number;
}

/**
 * 设备适配器接口
 *
 * 提供与旧 mpremote API 兼容的方法签名，
 * 内部使用新的 mpy_backend 实现。
 */
export interface DeviceAdapter {
    // ========================================================================
    // 连接管理
    // ========================================================================

    /**
     * 连接到设备
     * @param port 串口名称
     * @param baudrate 波特率，默认 115200
     */
    connect(port: string, baudrate?: number): Promise<void>;

    /**
     * 断开连接
     */
    disconnect(): Promise<void>;

    /**
     * 检查是否已连接
     */
    isConnected(): boolean;

    /**
     * 获取当前连接的端口
     */
    getPort(): string | null;

    // ========================================================================
    // 文件操作
    // ========================================================================

    /**
     * 列出目录内容 (原始字符串格式，兼容旧 API)
     * @param path 设备路径
     */
    ls(path: string): Promise<string>;

    /**
     * 列出目录内容 (类型化格式)
     * @param path 设备路径
     */
    lsTyped(path: string): Promise<FileEntry[]>;

    /**
     * 创建目录
     * @param path 设备路径
     */
    mkdir(path: string): Promise<void>;

    /**
     * 从设备复制文件到本地
     * @param devicePath 设备文件路径
     * @param localPath 本地文件路径
     */
    cpFromDevice(devicePath: string, localPath: string): Promise<void>;

    /**
     * 从本地复制文件到设备
     * @param localPath 本地文件路径
     * @param devicePath 设备文件路径
     */
    cpToDevice(localPath: string, devicePath: string): Promise<void>;

    /**
     * 删除文件
     * @param path 设备文件路径
     */
    deleteFile(path: string): Promise<void>;

    /**
     * 删除目录 (递归)
     * @param path 设备目录路径
     */
    deleteDirectory(path: string): Promise<void>;

    /**
     * 删除文件或目录
     * @param path 设备路径
     */
    deleteAny(path: string): Promise<void>;

    /**
     * 检查文件是否存在
     * @param path 设备路径
     */
    fileExists(path: string): Promise<boolean>;

    /**
     * 读取文件内容
     * @param path 设备文件路径
     */
    readFile(path: string): Promise<Uint8Array>;

    /**
     * 写入文件内容
     * @param path 设备文件路径
     * @param content 文件内容
     */
    writeFile(path: string, content: Uint8Array | string): Promise<void>;

    /**
     * 重命名/移动文件或目录
     * @param src 源路径
     * @param dst 目标路径
     */
    rename(src: string, dst: string): Promise<void>;

    /**
     * 获取文件/目录状态信息
     * @param path 设备路径
     * @returns 文件状态，如果不存在返回 null
     */
    stat(path: string): Promise<FileStat | null>;

    /**
     * 获取目录树的统计信息
     * @param rootPath 根路径
     * @returns 树状态数组
     */
    listTreeStats(rootPath: string): Promise<TreeStat[]>;

    /**
     * 获取设备文件和大小信息
     * @param rootPath 根路径
     * @returns 文件和目录的映射
     */
    getBoardFilesAndSizes(rootPath: string): Promise<BoardFilesResult>;

    /**
     * 上传文件并替换现有文件
     * @param localPath 本地文件路径
     * @param devicePath 设备路径
     */
    uploadReplacing(localPath: string, devicePath: string): Promise<void>;

    /**
     * 删除指定路径下的所有文件和目录
     * @param rootPath 根路径
     * @returns 删除结果
     */
    deleteAllInPath(rootPath: string): Promise<{deleted: string[], errors: string[]}>;

    /**
     * 在设备上移动/重命名文件
     * @param src 源路径
     * @param dst 目标路径
     */
    mvOnDevice(src: string, dst: string): Promise<void>;

    /**
     * 移动/重命名文件 (rename 的别名)
     * @param src 源路径
     * @param dst 目标路径
     */
    mv(src: string, dst: string): Promise<void>;

    // ========================================================================
    // 设备控制
    // ========================================================================

    /**
     * 软复位设备
     */
    reset(): Promise<void>;

    /**
     * 发送中断信号 (Ctrl+C)
     */
    interrupt(): Promise<void>;

    /**
     * 执行 Python 代码
     * @param code Python 代码
     */
    execute(code: string): Promise<ExecuteResult>;

    /**
     * 设备健康检查
     * @param port 可选的端口名称
     */
    healthCheck(port?: string): Promise<HealthCheckResult>;

    // ========================================================================
    // 信息查询
    // ========================================================================

    /**
     * 检测设备信息
     */
    detectBoardInfo(): Promise<BoardInfo | null>;

    /**
     * 列出可用串口
     */
    listSerialPorts(): Promise<SerialPortInfo[]>;

    // ========================================================================
    // 调试方法
    // ========================================================================

    /**
     * 调试树解析
     */
    debugTreeParsing(): Promise<void>;

    /**
     * 调试文件系统状态
     */
    debugFilesystemStatus(): Promise<void>;
}

/**
 * 设备适配器事件
 */
export interface DeviceAdapterEvents {
    /** 连接建立 */
    onConnect: (port: string) => void;
    /** 连接断开 */
    onDisconnect: (port: string, reason?: string) => void;
    /** 收到输出 */
    onOutput: (data: string) => void;
    /** 发生错误 */
    onError: (error: Error) => void;
}

/**
 * 获取默认设备适配器实例
 *
 * 这是一个工厂函数，返回当前配置的适配器实现。
 * 在迁移期间，可以通过配置切换新旧实现。
 */
export function getDeviceAdapter(): DeviceAdapter {
    // 延迟导入，避免循环依赖
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DeviceAdapterImpl } = require("./deviceAdapterImpl");
    return DeviceAdapterImpl.getInstance();
}

/**
 * 检查是否使用新后端
 */
export function isUsingNewBackend(): boolean {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode = require("vscode");
        const result = vscode.workspace
            .getConfiguration("microPythonWorkBench")
            .get("useNewBackend", false);
        return result === true;
    } catch {
        return false;
    }
}
