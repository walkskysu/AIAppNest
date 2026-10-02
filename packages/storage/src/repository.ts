import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { z } from 'zod';
import { DomainError } from '@aiappnest/domain';

export function storageError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const message = error instanceof Error ? error.message : '';
  const code = /UNIQUE constraint|PRIMARY KEY/.test(message) ? 'DUPLICATE_RECORD'
    : /FOREIGN KEY|ownership mismatch/.test(message) ? 'OWNERSHIP_MISMATCH'
    : /immutable|version conflict/.test(message) ? 'VERSION_CONFLICT'
    : /invalid transition/.test(message) ? 'INVALID_TRANSITION'
    : /CHECK constraint|NOT NULL|cannot store/.test(message) ? 'INVALID_INPUT' : 'STORAGE_UNAVAILABLE';
  return new DomainError(code, code, { cause: error });
}
export function guard<T>(action: () => T): T { try { return action(); } catch (error) { throw storageError(error); } }
export interface Page { limit?: number; offset?: number }
export interface Repository<T, K, S> {
  insert(value: T): T;
  get(key: K): T;
  list(scope: S, page?: Page): T[];
}
export interface RepositorySpec {
  table: string; schema: z.ZodObject; keys: string[]; scope: string[]; order: string;
  json?: string[]; nullableJson?: string[]; boolean?: string[]; validate?: (value: Record<string, unknown>) => void;
}
/** SQL identifiers come exclusively from private, source-controlled specs. Values are bound. */
export function repository<T, K, S>(db: DatabaseSync, spec: RepositorySpec): Repository<T, K, S> {
  const columns = Object.keys(spec.schema.shape);
  const decode = (row: Record<string, unknown>): T => {
    for (const key of spec.json ?? []) if (row[key] !== null) row[key] = JSON.parse(row[key] as string);
    for (const key of spec.boolean ?? []) row[key] = row[key] === 1;
    return { ...row } as T;
  };
  const filter = (value: unknown, keys: string[]): SQLInputValue[] => {
    if (!value || typeof value !== 'object' || Object.keys(value).length !== keys.length) throw new DomainError('INVALID_INPUT');
    return keys.map(key => {
      const result = (spec.schema.shape[key] as z.ZodType).safeParse((value as Record<string, unknown>)[key]);
      if (!result.success || result.data === undefined) throw new DomainError('INVALID_INPUT');
      return result.data as SQLInputValue;
    });
  };
  return {
    insert(value) { return guard(() => {
      const parsed = spec.schema.safeParse(value);
      if (!parsed.success) throw new DomainError('INVALID_INPUT');
      const record = parsed.data as Record<string, unknown>;
      spec.validate?.(record);
      const values = columns.map(key => {
        const item = record[key];
        if (spec.json?.includes(key) && !(item === null && spec.nullableJson?.includes(key))) return JSON.stringify(item);
        if (item === null) return null;
        if (spec.boolean?.includes(key)) return item ? 1 : 0;
        return item as SQLInputValue;
      });
      db.prepare(`INSERT INTO ${spec.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
      return decode(Object.fromEntries(columns.map((key, i) => [key, values[i]])));
    }); },
    get(key) { return guard(() => {
      const values = filter(key, spec.keys);
      const row = db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.keys.map(key => `${key}=?`).join(' AND ')}`).get(...values);
      if (!row) throw new DomainError('NOT_FOUND');
      return decode(row);
    }); },
    list(scope, page = {}) { return guard(() => {
      const values = filter(scope, spec.scope);
      const { limit = 100, offset = 0 } = page;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new DomainError('INVALID_INPUT');
      return db.prepare(`SELECT * FROM ${spec.table}${spec.scope.length ? ` WHERE ${spec.scope.map(key => `${key}=?`).join(' AND ')}` : ''} ORDER BY ${spec.order} LIMIT ? OFFSET ?`).all(...values, limit, offset).map(decode);
    }); },
  };
}
