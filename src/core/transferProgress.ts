import type { FileTransferProgress } from "../board/mpyClient";

interface ProgressReporter {
  report(value: { increment?: number; message?: string }): void;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function createTransferProgressReporter(progress: ProgressReporter, totalBytes = 0) {
  const startedAt = Date.now();
  const transferredByKey = new Map<string, number>();
  const totalByKey = new Map<string, number>();
  let lastPercent = 0;

  return (label: string, event: FileTransferProgress) => {
    const key = event.devicePath || event.localPath || label;
    const total = Math.max(0, event.total || 0);
    const bytes = Math.min(Math.max(0, event.bytes || 0), total || Math.max(0, event.bytes || 0));
    transferredByKey.set(key, bytes);
    if (total) totalByKey.set(key, total);

    const transferred = Array.from(transferredByKey.values()).reduce((sum, value) => sum + value, 0);
    const aggregateTotal = totalBytes || Array.from(totalByKey.values()).reduce((sum, value) => sum + value, 0);
    const percent = aggregateTotal > 0 ? Math.min(100, (transferred / aggregateTotal) * 100) : 0;
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const speed = transferred / elapsedSeconds;
    const increment = Math.max(0, percent - lastPercent);
    lastPercent = Math.max(lastPercent, percent);

    progress.report({
      increment,
      message: `${label} ${formatBytes(bytes)}/${formatBytes(total)} (${percent.toFixed(1)}%, ${formatSpeed(speed)})`,
    });
  };
}
