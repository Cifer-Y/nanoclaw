import fs from 'fs';
import path from 'path';
import pino from 'pino';
import {
  GROUPS_DIR,
  DATA_DIR,
  RETENTION_CONTAINER_LOGS_DAYS,
  RETENTION_TASK_RUN_LOGS_DAYS,
  RETENTION_IPC_ERRORS_DAYS,
  RETENTION_MESSAGES_DAYS
} from './config.js';
import { deleteOldTaskRunLogs, getExpiredMediaPaths, deleteOldMessages } from './db.js';
import { RegisteredGroup } from './types.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Delete container log files older than retention period.
 * Parses timestamp from filename: container-2026-02-03T16-13-00-273Z.log
 */
function cleanContainerLogs(retentionDays: number): number {
  const cutoff = daysAgo(retentionDays);
  let deleted = 0;

  let groups: string[];
  try {
    groups = fs.readdirSync(GROUPS_DIR).filter(f =>
      fs.statSync(path.join(GROUPS_DIR, f)).isDirectory()
    );
  } catch {
    return 0;
  }

  for (const group of groups) {
    const logsDir = path.join(GROUPS_DIR, group, 'logs');
    if (!fs.existsSync(logsDir)) continue;

    const files = fs.readdirSync(logsDir).filter(f => f.startsWith('container-') && f.endsWith('.log'));
    for (const file of files) {
      // container-2026-02-03T16-13-00-273Z.log -> 2026-02-03T16:13:00.273Z
      const tsStr = file.slice('container-'.length, -'.log'.length);
      const isoStr = tsStr.replace(
        /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
        '$1:$2:$3.$4'
      );
      const fileDate = new Date(isoStr);
      if (isNaN(fileDate.getTime())) continue;

      if (fileDate < cutoff) {
        try {
          fs.unlinkSync(path.join(logsDir, file));
          deleted++;
        } catch (err: any) {
          if (err.code !== 'ENOENT') logger.warn({ file, err }, 'Failed to delete log file');
        }
      }
    }
  }

  return deleted;
}

/**
 * Delete task run log records older than retention period.
 */
function cleanTaskRunLogs(retentionDays: number): number {
  const cutoff = daysAgo(retentionDays).toISOString();
  return deleteOldTaskRunLogs(cutoff);
}

/**
 * Delete IPC error files older than retention period.
 * Uses file mtime since error files don't have timestamps in names.
 */
function cleanIpcErrors(retentionDays: number): number {
  const errorsDir = path.join(DATA_DIR, 'ipc', 'errors');
  if (!fs.existsSync(errorsDir)) return 0;

  const cutoffMs = daysAgo(retentionDays).getTime();
  let deleted = 0;

  const files = fs.readdirSync(errorsDir);
  for (const file of files) {
    const filePath = path.join(errorsDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') logger.warn({ file, err }, 'Failed to delete IPC error file');
    }
  }

  return deleted;
}

/**
 * Delete expired messages and their associated image files.
 * Order: query images -> delete files -> delete DB rows.
 */
function cleanMessages(
  retentionDays: number,
  registeredGroups: Record<string, RegisteredGroup>
): { messagesDeleted: number; imagesDeleted: number } {
  const cutoff = daysAgo(retentionDays).toISOString();

  // Find images to delete before removing DB records
  const imagesToDelete = getExpiredMediaPaths(cutoff);

  let imagesDeleted = 0;
  for (const row of imagesToDelete) {
    const group = registeredGroups[row.chat_jid];
    if (!group) continue;

    const imagePath = path.join(GROUPS_DIR, group.folder, row.media_path);
    try {
      fs.unlinkSync(imagePath);
      imagesDeleted++;
    } catch (err: any) {
      if (err.code !== 'ENOENT') logger.warn({ path: imagePath, err }, 'Failed to delete image');
    }
  }

  const messagesDeleted = deleteOldMessages(cutoff);

  return { messagesDeleted, imagesDeleted };
}

/**
 * Run all cleanup tasks. Called on startup and periodically.
 */
export async function runCleanup(
  registeredGroups: Record<string, RegisteredGroup>
): Promise<void> {
  const containerLogs = cleanContainerLogs(RETENTION_CONTAINER_LOGS_DAYS);
  const taskRunLogs = cleanTaskRunLogs(RETENTION_TASK_RUN_LOGS_DAYS);
  const ipcErrors = cleanIpcErrors(RETENTION_IPC_ERRORS_DAYS);
  const { messagesDeleted, imagesDeleted } = cleanMessages(RETENTION_MESSAGES_DAYS, registeredGroups);

  logger.info({
    containerLogs,
    taskRunLogs,
    ipcErrors,
    messages: messagesDeleted,
    images: imagesDeleted
  }, 'Cleanup completed');
}
