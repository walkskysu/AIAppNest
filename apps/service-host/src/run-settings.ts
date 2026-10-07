import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Storage } from '@aiappnest/storage';
import type { SchedulerOptions } from './runs';

const positive = z.number().int().min(1).max(2147483647);
const settingsSchema = z.strictObject({ concurrency: positive.max(32).optional(), localConcurrency: positive.max(32).optional(),
  modelLimits: z.record(z.string().regex(/^[a-f0-9]{64}$/), positive.max(32)).optional(), queueLimit: positive.max(1000).optional(),
  queueTimeoutMs: positive.optional(), idleTtlMs: positive.optional(), abortMs: positive.max(3000).optional() });
/** Private host configuration, read at startup. No arbitrary paths or worker factories over IPC. */
export function readRunSettings(storage: Storage): SchedulerOptions {
  const path = join(storage.paths.root, 'run-settings.json'); storage.paths.assertManaged(path);
  if (!existsSync(path)) return {};
  if (statSync(path).size > 16384) throw new Error('INVALID_RUN_SETTINGS');
  return settingsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
