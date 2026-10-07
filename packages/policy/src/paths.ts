import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

export class PolicyDenied extends Error {
  constructor(readonly reason: string) { super(JSON.stringify({ code: 'POLICY_DENIED', reason })); }
}
export function deny(reason: string): never { throw new PolicyDenied(reason); }

/** Deliberately conservative: no UNC, device namespace, ADS, DOS aliases or links. */
export function validatePathSyntax(value: string): void {
  if (!value || value.length > 4096 || /[\x00-\x1f<>"|?*~]/.test(value)) deny('UNSUPPORTED_PATH');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('//') || normalized.startsWith('/??/') || /^\\/.test(value)) deny('UNSUPPORTED_PATH');
  if (process.platform === 'win32' && normalized.startsWith('/')) deny('DRIVE_REQUIRED');
  if (/^[a-z]:/i.test(value) && !/^[a-z]:[/\\]/i.test(value)) deny('DRIVE_RELATIVE_PATH');
  const rest = normalized.replace(/^[a-z]:\//i, '');
  if (rest.includes(':')) deny('UNSUPPORTED_PATH');
  for (const part of rest.split('/')) {
    if (part === '..') deny('PATH_TRAVERSAL');
    if (part === '.' || part === '') continue;
    if (/[. ]$/.test(part) || /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)) deny('UNSUPPORTED_PATH');
  }
  if (process.platform !== 'win32' && /^[a-z]:/i.test(value)) deny('UNSUPPORTED_PATH');
}

function inspect(absolute: string): void {
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) deny('LINK_OR_SPECIAL_FILE');
  }
}
export function canonicalDirectory(directory: string): string {
  validatePathSyntax(directory);
  if (!isAbsolute(directory)) deny('ABSOLUTE_ROOT_REQUIRED');
  const absolute = resolve(directory);
  inspect(absolute);
  if (!lstatSync(absolute).isDirectory()) deny('DIRECTORY_REQUIRED');
  return realpathSync.native(absolute);
}
// Inputs are real paths, with canonical casing supplied by the OS. Do not case-fold:
// Windows directories can opt into case sensitivity. Match complete components.
export function within(root: string, target: string): boolean {
  const a = root.split(sep).filter(Boolean), b = target.split(sep).filter(Boolean);
  return a.length <= b.length && a.every((part, i) => part === b[i]);
}
export function checkedTarget(root: string, input: string, create: boolean): { path: string; exists: boolean } {
  validatePathSyntax(input);
  const canonicalRoot = canonicalDirectory(root);
  if (canonicalRoot !== root) deny('ROOT_CHANGED');
  const path = resolve(root, input.replaceAll('\\', sep));
  // Existing ancestors (including parents of new files) must be real and unlinked.
  const parent = canonicalDirectory(dirname(path));
  if (path !== root && !within(root, parent)) deny('OUTSIDE_GRANT');
  try {
    inspect(path);
    const real = realpathSync.native(path);
    if (!within(root, real)) deny('OUTSIDE_GRANT');
    return { path: real, exists: true };
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!within(root, parent)) deny('OUTSIDE_GRANT');
    return { path: join(parent, parse(path).base), exists: false };
  }
}
