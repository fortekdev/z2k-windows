// Списки доменов/адресов. Три слоя:
//   base    — снимок из resources/lists/z2k (как раскладывает установщик z2k);
//   updated — свежие списки runetfreedom/russia-blocked-geosite (data/lists/auto), постобработка как в z2k-geosite.sh;
//   user    — свои домены, исключения по домену и по адресу (data/lists/*.txt).
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ListInfo } from '../../../shared/types';
import { data, res } from '../paths';
import { log } from '../logger';

const GEOSITE = 'https://github.com/runetfreedom/russia-blocked-geosite/releases/latest/download/';

// Относительные пути z2k (после @Z2K@/) → слой
export const Z2K_LISTS = {
  rkn: 'extra_strats/TCP/RKN/List.txt',
  yt: 'extra_strats/TCP/YT/List.txt',
  gv: 'extra_strats/TCP/YT_GV/List.txt',
  ytUdp: 'extra_strats/UDP/YT/List.txt',
  discord: 'extra_strats/TCP_Discord.txt',
} as const;

export const USER_LISTS = {
  extra: 'extra-domains.txt',
  excludeDomains: 'exclude-domains.txt',
  excludeIps: 'exclude-ips.txt',
  ipfix: 'ipfix-domains.txt', // обход блокировки по IP подменой адреса в DNS-ответах
} as const;

function baseFile(rel: string) {
  return join(res.lists(), 'z2k', ...rel.split('/'));
}
function autoFile(rel: string) {
  return join(data.lists(), 'auto', ...rel.split('/'));
}
export function userFile(name: string) {
  return join(data.lists(), name);
}

/** Актуальный файл z2k-списка: обновлённый, если есть, иначе снимок из ресурсов */
export function z2kList(rel: string): string {
  const a = autoFile(rel);
  return existsSync(a) && statSync(a).size > 0 ? a : baseFile(rel);
}

export function whitelistFile(): string {
  return baseFile('whitelist.txt');
}

/** Пользовательские списки создаются при первом запуске; extra-domains — из поставки z2k */
export function ensureUserLists() {
  const extra = userFile(USER_LISTS.extra);
  if (!existsSync(extra)) {
    const seed = join(res.lists(), 'extra-domains.txt');
    if (existsSync(seed)) copyFileSync(seed, extra);
    else writeFileSync(extra, '');
  }
  for (const name of [USER_LISTS.excludeDomains, USER_LISTS.excludeIps, USER_LISTS.ipfix]) {
    const f = userFile(name);
    if (!existsSync(f)) writeFileSync(f, '');
  }
}

export function readEntries(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function countEntries(file: string): number {
  return readEntries(file).length;
}

export function hasEntries(file: string): boolean {
  return countEntries(file) > 0;
}

function writeAtomic(file: string, lines: string[]) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', lines.join('\n') + (lines.length ? '\n' : ''));
  renameSync(file + '.tmp', file);
}

// ---------- нормализация доменов ----------

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z0-9-]{2,}$/i;
const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-f:]+:[0-9a-f:]*(\/\d{1,3})?)$/i;

export function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  d = d.replace(/^\*\./, '');
  if (d.startsWith('www.')) d = d.slice(4);
  return DOMAIN_RE.test(d) ? d : null;
}

export function isIpOrCidr(s: string) {
  return IP_RE.test(s.trim());
}

/** Совпадение по суффиксу на границе меток (как в хостлистах nfqws2) */
export function domainCovers(base: string, d: string) {
  return d === base || d.endsWith('.' + base);
}

// ---------- информация и правка ----------

const LIST_META: { id: string; title: string; description: string; file: () => string; editable: boolean }[] = [
  { id: 'extra', title: 'Свои домены', description: 'Обходятся профилем RKN (TLS, HTTP) и QUIC. Поддомены покрываются автоматически.', file: () => userFile(USER_LISTS.extra), editable: true },
  { id: 'exclude-domains', title: 'Исключения: домены', description: 'Эти домены z2k не трогает (банки, госуслуги, игровые магазины…).', file: () => userFile(USER_LISTS.excludeDomains), editable: true },
  { id: 'exclude-ips', title: 'Исключения: адреса', description: 'IP/подсети, к которым не применяется обход (камеры, VoIP без имени в трафике).', file: () => userFile(USER_LISTS.excludeIps), editable: true },
  { id: 'ipfix', title: 'Обход блокировки по IP', description: 'Сайты, заблокированные по IP-адресу. Движок подменяет адрес в ответе DNS на рабочий адрес того же сайта из другой страны (замена принимается только с действительным TLS-сертификатом на домен). Сайты из списка также получают пакетный обход. Не действует при «безопасном DNS» в браузере.', file: () => userFile(USER_LISTS.ipfix), editable: true },
  { id: 'rkn', title: 'RKN (заблокированные)', description: 'runetfreedom/russia-blocked-geosite ru-blocked', file: () => z2kList(Z2K_LISTS.rkn), editable: false },
  { id: 'yt', title: 'YouTube (TCP)', description: 'youtube.com и связанные домены', file: () => z2kList(Z2K_LISTS.yt), editable: false },
  { id: 'gv', title: 'YouTube видео (googlevideo)', description: 'CDN видеопотока', file: () => z2kList(Z2K_LISTS.gv), editable: false },
  { id: 'yt-udp', title: 'QUIC (YouTube)', description: 'Домены для обхода по QUIC/UDP 443', file: () => z2kList(Z2K_LISTS.ytUdp), editable: false },
  { id: 'discord', title: 'Discord', description: 'Домены Discord (входят в профиль RKN)', file: () => z2kList(Z2K_LISTS.discord), editable: false },
  { id: 'whitelist', title: 'Базовые исключения z2k', description: 'Готовый список исключений из поставки z2k', file: () => whitelistFile(), editable: false },
];

export function listInfos(): ListInfo[] {
  return LIST_META.map((m) => ({ id: m.id, title: m.title, description: m.description, file: m.file(), editable: m.editable, count: countEntries(m.file()) }));
}

export function readList(id: string, limit = 5000): { entries: string[]; total: number } {
  const meta = LIST_META.find((m) => m.id === id);
  if (!meta) throw new Error(`unknown list ${id}`);
  const entries = readEntries(meta.file());
  return { entries: entries.slice(0, limit), total: entries.length };
}

/** Где уже лежит домен (сам или родитель) — чтобы не плодить дубликаты, как в панели z2k */
export function whereListed(domain: string): string[] {
  const found: string[] = [];
  for (const m of LIST_META) {
    if (m.id === 'exclude-ips') continue;
    const entries = readEntries(m.file());
    if (entries.some((e) => domainCovers(e.toLowerCase(), domain))) found.push(m.title);
  }
  return found;
}

export function writeUserList(id: string, raw: string[]): { saved: number; rejected: string[] } {
  const meta = LIST_META.find((m) => m.id === id);
  if (!meta || !meta.editable) throw new Error('Список нельзя редактировать');
  const rejected: string[] = [];
  const out = new Set<string>();
  for (const line of raw) {
    const v = line.trim();
    if (!v || v.startsWith('#')) continue;
    if (id === 'exclude-ips') {
      if (isIpOrCidr(v)) out.add(v.toLowerCase());
      else rejected.push(v);
    } else {
      const d = normalizeDomain(v);
      if (d) out.add(d);
      else rejected.push(v);
    }
  }
  writeAtomic(meta.file(), [...out].sort());
  return { saved: out.size, rejected };
}

// ---------- обновление из runetfreedom (порт z2k-geosite.sh) ----------

function normalizeGeosite(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    let d = raw.trim();
    if (!d || d.startsWith('#')) continue;
    d = d.split(/\s+/)[0].replace(/^domain:/, '').replace(/^full:/, '');
    if (d.startsWith('regexp:') || d.startsWith('keyword:')) continue;
    d = d.replace(/[\s:]*@[a-zA-Z0-9_.-]+.*$/, '').toLowerCase().replace(/\.$/, '');
    if (d && /[a-z0-9]/.test(d)) out.add(d);
  }
  return [...out].sort();
}

const GOOGLE_EXCLUDED = ['chatgpt.com', 'claude.ai', 'github.com', 'cloudflareclient.com', 'cloudflare-dns.com'];

// Аккаунты Google, переводчик и т.п. не должны попадать под обход — только Meet
export function filterGoogle(list: string[]): string[] {
  return list.filter((d) => {
    if ((d === 'google.com' || d.endsWith('.google.com')) && d !== 'meet.google.com') return false;
    return !GOOGLE_EXCLUDED.some((b) => domainCovers(b, d));
  });
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

function acceptShrink(rel: string, next: string[]): boolean {
  const cur = countEntries(z2kList(rel));
  if (cur > 50 && next.length < cur * 0.8) {
    log.warn('lists', `${rel}: новый список заметно меньше (${next.length} < 80% от ${cur}) — отвергнут`);
    return false;
  }
  return true;
}

export async function updateLists(): Promise<{ ok: boolean; summary: string }> {
  log.info('lists', 'Обновление списков из runetfreedom/russia-blocked-geosite…');
  const [rknRaw, ytRaw, discordRaw] = await Promise.all([
    fetchText(GEOSITE + 'ru-blocked.txt'),
    fetchText(GEOSITE + 'youtube.txt'),
    fetchText(GEOSITE + 'discord.txt'),
  ]);
  const fp = new Set(readEntries(join(res.lists(), 'rkn-false-positive.txt')).map((s) => s.toLowerCase()));

  const ytAll = normalizeGeosite(ytRaw);
  const login = ['accounts.youtube.com', 'oauth2.googleapis.com'];
  const ytTcp = filterGoogle([...new Set([...ytAll.filter((d) => !domainCovers('googlevideo.com', d)), ...login])].sort());
  const ytUdp = filterGoogle([...new Set([...ytAll, ...login])].sort());
  const discord = filterGoogle(normalizeGeosite(discordRaw));

  // Из RKN убираем то, что обслуживают YouTube-профили (вместе с родительскими доменами), googlevideo и ложные срабатывания
  const ytSet = new Set(ytTcp);
  const coveredByYt = (d: string) => {
    const parts = d.split('.');
    for (let i = 0; i < parts.length - 1; i++) if (ytSet.has(parts.slice(i).join('.'))) return true;
    return false;
  };
  const rkn = filterGoogle(normalizeGeosite(rknRaw)).filter((d) => !coveredByYt(d) && !domainCovers('googlevideo.com', d) && !fp.has(d));

  const results: string[] = [];
  const apply = (rel: string, list: string[], label: string) => {
    if (list.length === 0 || !acceptShrink(rel, list)) {
      results.push(`${label}: пропущен`);
      return;
    }
    writeAtomic(autoFile(rel), list);
    results.push(`${label}: ${list.length}`);
  };
  apply(Z2K_LISTS.rkn, rkn, 'RKN');
  apply(Z2K_LISTS.yt, ytTcp, 'YouTube');
  apply(Z2K_LISTS.ytUdp, ytUdp, 'QUIC');
  apply(Z2K_LISTS.discord, discord, 'Discord');

  // Свои домены тоже чистим от Google-аккаунтов
  const extra = userFile(USER_LISTS.extra);
  writeAtomic(extra, filterGoogle(readEntries(extra)));

  const summary = results.join(', ');
  log.info('lists', `Списки обновлены: ${summary}`);
  return { ok: true, summary };
}
