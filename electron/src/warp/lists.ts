// Списки игрового режима WARP — порт update_warp_game_list (z2k-update-lists.sh) и z2k-warp-list-filter.awk.
// Источник: YOZH3G/ru-gaming-blocklist — по файлу на игру (games/<Имя>.txt), индекс sources.json → game_map.
// Общий IP-набор апстрима НЕ используется: он покрывал ~15% IPv4 вместе с частными сетями (issue z2k #26).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { data } from '../paths';
import { log } from '../logger';

const BASE = 'https://raw.githubusercontent.com/YOZH3G/ru-gaming-blocklist/main';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function warpDir() {
  const d = join(data.root(), 'warp');
  mkdirSync(join(d, 'games'), { recursive: true });
  return d;
}
const gamesDir = () => join(warpDir(), 'games');
export const userIpsFile = () => join(warpDir(), 'user-ips.txt');
export const userDomainsFile = () => join(warpDir(), 'user-domains.txt');

// ---------- фильтр (как z2k-warp-list-filter.awk) ----------

export function addrOk(s: string): boolean {
  if (!/^[1-9][0-9]{0,2}(\.(0|[1-9][0-9]{0,2})){3}(\/([1-9]|[12][0-9]|3[0-2]))?$/.test(s)) return false;
  const o = s.split('/')[0].split('.').map(Number);
  if (o.some((x) => x > 255)) return false;
  if (o[0] === 10 || o[0] === 127 || o[0] >= 224) return false;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false;
  if (o[0] === 169 && o[1] === 254) return false;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
  if (o[0] === 192 && o[1] === 168) return false;
  if (o[0] === 192 && o[1] === 0 && (o[2] === 0 || o[2] === 2)) return false;
  if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return false;
  if (o[0] === 198 && o[1] === 51 && o[2] === 100) return false;
  if (o[0] === 203 && o[1] === 0 && o[2] === 113) return false;
  return true;
}

export function domainOk(s: string): boolean {
  if (s.length > 255 || /[^A-Za-z0-9.*-]/.test(s)) return false;
  const d = s.startsWith('*.') ? s.slice(2) : s;
  if (d.includes('*') || d.length < 4 || d.length > 253) return false;
  const labels = d.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => l.length >= 1 && l.length <= 63 && (/^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/.test(l) || /^[A-Za-z0-9]$/.test(l)))) return false;
  const tld = labels[labels.length - 1];
  return /^[A-Za-z]+$/.test(tld) || /^xn--[A-Za-z0-9-]+$/.test(tld);
}

export interface Classified { ips: string[]; domains: string[]; invalid: string[] }

export function classify(text: string): Classified {
  const out: Classified = { ips: [], domains: [], invalid: [] };
  for (const raw of text.split(/\r?\n/)) {
    const v = raw.trim();
    if (!v || v.startsWith('#')) continue;
    if (addrOk(v)) out.ips.push(v);
    else if (domainOk(v)) out.domains.push(v.toLowerCase());
    else out.invalid.push(v);
  }
  return out;
}

// ---------- каталог игр ----------

export interface GameInfo { id: string; title: string; ips: number; domains: number; aliases: string[] }

function readIndex(): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(join(warpDir(), 'games-index.json'), 'utf8')).game_map ?? {};
  } catch {
    return {};
  }
}

export function listGames(): GameInfo[] {
  const map = readIndex();
  const aliases = new Map(Object.entries(map).map(([k, v]) => [k.replace(/ /g, '_'), v]));
  if (!existsSync(gamesDir())) return [];
  return readdirSync(gamesDir())
    .filter((f) => f.endsWith('.txt'))
    .map((f) => {
      const id = f.slice(0, -4);
      const c = classify(readFileSync(join(gamesDir(), f), 'utf8'));
      return { id, title: id.replace(/_/g, ' '), ips: c.ips.length, domains: c.domains.length, aliases: aliases.get(id) ?? [] };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function gameEntries(id: string): Classified {
  if (!NAME_RE.test(id)) return { ips: [], domains: [], invalid: [] };
  const f = join(gamesDir(), `${id}.txt`);
  return existsSync(f) ? classify(readFileSync(f, 'utf8')) : { ips: [], domains: [], invalid: [] };
}

export async function updateGames(): Promise<{ ok: number; skipped: number }> {
  const r = await fetch(`${BASE}/sources.json`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`индекс игр недоступен: HTTP ${r.status}`);
  const index = (await r.json()) as { game_map?: Record<string, string[]> };
  const names = Object.keys(index.game_map ?? {}).map((n) => n.replace(/ /g, '_')).filter((n) => NAME_RE.test(n) && n !== 'Other_Games');
  if (!names.length) throw new Error('в индексе нет игр');
  writeFileSync(join(warpDir(), 'games-index.json'), JSON.stringify(index));

  let ok = 0, skipped = 0;
  await Promise.all(names.map(async (n) => {
    try {
      const res = await fetch(`${BASE}/games/${n}.txt`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) { skipped++; return; } // игра есть в индексе, но файл ещё не опубликован — норма
      const c = classify(await res.text());
      const dest = join(gamesDir(), `${n}.txt`);
      if (!c.ips.length && !c.domains.length) { rmSync(dest, { force: true }); skipped++; return; }
      writeFileSync(dest + '.tmp', [...c.ips, ...c.domains].join('\n') + '\n');
      renameSync(dest + '.tmp', dest);
      ok++;
    } catch {
      skipped++;
    }
  }));
  // Уборка игр, выпавших из индекса
  const keep = new Set(names.map((n) => `${n}.txt`));
  for (const f of readdirSync(gamesDir())) if (f.endsWith('.txt') && !keep.has(f)) rmSync(join(gamesDir(), f), { force: true });
  log.info('app', `WARP: списки игр обновлены — ${ok}, пропущено ${skipped}`);
  return { ok, skipped };
}

// ---------- свои списки ----------

export function readUser(kind: 'ips' | 'domains'): string[] {
  const f = kind === 'ips' ? userIpsFile() : userDomainsFile();
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function writeUser(kind: 'ips' | 'domains', entries: string[]): { saved: number; rejected: string[] } {
  const ok = new Set<string>();
  const rejected: string[] = [];
  for (const e of entries.map((x) => x.trim()).filter(Boolean)) {
    if (kind === 'ips' ? addrOk(e) : domainOk(e)) ok.add(kind === 'domains' ? e.toLowerCase() : e);
    else rejected.push(e);
  }
  const f = kind === 'ips' ? userIpsFile() : userDomainsFile();
  writeFileSync(f, [...ok].join('\n') + (ok.size ? '\n' : ''));
  return { saved: ok.size, rejected };
}
