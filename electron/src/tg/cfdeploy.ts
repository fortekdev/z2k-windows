// Публикация Telegram-релея в аккаунт Cloudflare пользователя через API (бесплатный план Workers подходит).
// Нужен API-токен по шаблону «Edit Cloudflare Workers». Токен не сохраняется — только URL и секрет релея.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resourcesDir } from '../paths';
import { log } from '../logger';

const API = 'https://api.cloudflare.com/client/v4';

interface CfResponse<T> { success: boolean; errors?: { code: number; message: string }[]; result: T }

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await r.json().catch(() => ({ success: false, errors: [{ code: r.status, message: r.statusText }] }))) as CfResponse<T>;
  if (!j.success) throw new Error(j.errors?.map((e) => `${e.message} (${e.code})`).join('; ') || `HTTP ${r.status}`);
  return j.result;
}

export function workerSource(): string {
  return readFileSync(join(resourcesDir(), 'cf-worker', 'worker.js'), 'utf8');
}

export function newSecret(): string {
  return randomBytes(32).toString('hex');
}

export interface DeployResult { url: string; secret: string; account: string; script: string }

export async function deployWorker(token: string, scriptName = 'z2k-tg-relay'): Promise<DeployResult> {
  const t = token.trim();
  if (!t) throw new Error('Укажите API-токен Cloudflare');
  const accounts = await cf<{ id: string; name: string }[]>(t, '/accounts?per_page=5');
  if (!accounts.length) throw new Error('Токену не доступен ни один аккаунт');
  const acc = accounts[0];
  log.info('tg', `Cloudflare: аккаунт «${acc.name}», публикую Worker ${scriptName}…`);

  const secret = newSecret();
  const form = new FormData();
  form.append('metadata', JSON.stringify({
    main_module: 'worker.js',
    compatibility_date: '2025-09-01',
    bindings: [{ type: 'secret_text', name: 'TUNNEL_SECRET', text: secret }],
  }));
  form.append('worker.js', new Blob([workerSource()], { type: 'application/javascript+module' }), 'worker.js');
  await cf(t, `/accounts/${acc.id}/workers/scripts/${scriptName}`, { method: 'PUT', body: form });

  // Поддомен *.workers.dev аккаунта; если его ещё нет — заводим
  let sub: string | null = null;
  try {
    sub = (await cf<{ subdomain: string }>(t, `/accounts/${acc.id}/workers/subdomain`)).subdomain || null;
  } catch { /* нет поддомена */ }
  if (!sub) {
    const wanted = `z2k-${randomBytes(3).toString('hex')}`;
    sub = (await cf<{ subdomain: string }>(t, `/accounts/${acc.id}/workers/subdomain`, { method: 'PUT', body: JSON.stringify({ subdomain: wanted }) })).subdomain;
  }
  await cf(t, `/accounts/${acc.id}/workers/scripts/${scriptName}/subdomain`, { method: 'POST', body: JSON.stringify({ enabled: true, previews_enabled: false }) });

  const url = `wss://${scriptName}.${sub}.workers.dev/ws`;
  log.info('tg', `Cloudflare Worker опубликован: ${url}`);
  return { url, secret, account: acc.name, script: scriptName };
}
