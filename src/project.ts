import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTestKeys } from './keys.js';
import { parseLocalUrl } from './delivery.js';

const FORMAT = 'hookbuoy.project.v1' as const;
export type Profile = 'custom' | 'arc-commerce';
export type ProjectConfig = {
  format: typeof FORMAT;
  endpoint: string;
  profile: Profile;
  lastDelivery?: string;
};

export function projectDir(cwd = process.cwd()): string {
  return resolve(cwd, '.hookbuoy');
}
function configPath(cwd = process.cwd()): string {
  return join(projectDir(cwd), 'config.json');
}
async function has(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
export async function loadProject(cwd = process.cwd()): Promise<ProjectConfig | null> {
  const file = configPath(cwd);
  let length: number;
  try { length = (await stat(file)).size; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  if (length > 16384) throw new Error('Project config exceeds 16 KiB');
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid project configuration');
  const data = value as Record<string, unknown>;
  if (data.format !== FORMAT ||
      (data.profile !== 'custom' && data.profile !== 'arc-commerce') ||
      typeof data.endpoint !== 'string' ||
      (data.lastDelivery !== undefined && typeof data.lastDelivery !== 'string')) {
    throw new Error('Invalid or unsupported project configuration');
  }
  parseLocalUrl(data.endpoint);
  return data as ProjectConfig;
}
export async function initProject(endpoint: string, profile: Profile, cwd = process.cwd()): Promise<{ reusedKeys: boolean }> {
  parseLocalUrl(endpoint);
  if (await loadProject(cwd)) throw new Error('Project already initialized; config unchanged');
  const dir = projectDir(cwd);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const priv = await has(join(dir, 'private.pem'));
  const pub = await has(join(dir, 'public.pem'));
  if (priv !== pub) throw new Error('Incomplete test key pair; no existing key overwritten');
  if (!priv) await createTestKeys(dir);
  const config: ProjectConfig = { format: FORMAT, endpoint, profile };
  await writeFile(configPath(cwd), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { reusedKeys: priv };
}
export async function keyStatus(cwd = process.cwd()): Promise<'ready'|'missing'|'incomplete'> {
  const dir = projectDir(cwd);
  const priv = await has(join(dir, 'private.pem'));
  const pub = await has(join(dir, 'public.pem'));
  return priv && pub ? 'ready' : priv || pub ? 'incomplete' : 'missing';
}
export async function rememberDelivery(config: ProjectConfig, path: string, cwd = process.cwd()): Promise<void> {
  const tmp = join(projectDir(cwd), '.config-' + randomUUID() + '.tmp');
  try {
    await writeFile(tmp, JSON.stringify({ ...config, lastDelivery: resolve(path) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(tmp, configPath(cwd));
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
export function nextDelivery(cwd = process.cwd()): string {
  return join(projectDir(cwd), 'deliveries', randomUUID() + '.delivery.json');
}
export async function ensureDeliveryDir(cwd = process.cwd()): Promise<void> {
  await mkdir(join(projectDir(cwd), 'deliveries'), { recursive: true, mode: 0o700 });
}
