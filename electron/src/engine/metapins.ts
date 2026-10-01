// Обход блокировки по IP через подмену адреса в DNS-ответах — развитие идеи z2k-insta-ip-refresh.sh, без правки hosts:
// движок (lua z2k-win-dnsfix.lua) меняет заблокированный адрес на рабочий прямо во входящем DNS-ответе.
// Здесь строится карта «заблокированный IP → рабочий IP»:
//   1) адреса домена от местного DNS (и DoH 1.1.1.1 — его ответ тоже «российский»);
//   2) адрес не отвечает по TCP 443 → блокировка по IP;
//   3) кандидаты — что домен отдаёт в других странах (DoH Google + EDNS Client Subnet), а для сайтов за Cloudflare —
//      ещё и адреса других подсетей Cloudflare (любой узел Cloudflare обслуживает любой сайт Cloudflare);
//   4) замена принимается только с доказательством принадлежности:
//      Meta — адрес из диапазонов Meta (как в z2k), свои домены — действительный TLS-сертификат на этот домен.
// Карта строится по самим IP, поэтому на неё не влияет уже работающая подмена.
// Заблокированный адрес недоступен для всех сайтов на нём, так что подмена ничего не может сделать хуже.
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { data, res } from '../paths';
import { log } from '../logger';
import { readEntries, userFile, USER_LISTS } from './lists';

export const META_HOSTS = [
  'instagram.com', 'www.instagram.com', 'i.instagram.com', 'graph.instagram.com', 'api.instagram.com', 'b.i.instagram.com',
  'static.cdninstagram.com', 'scontent.cdninstagram.com',
  'web.whatsapp.com', 'www.whatsapp.com', 'scontent.whatsapp.net', 'graph.whatsapp.com', 'v.whatsapp.com',
  'facebook.com', 'www.facebook.com', 'static.xx.fbcdn.net', 'scontent.xx.fbcdn.net',
];
// «Другие страны» для EDNS Client Subnet: США, Германия, Нидерланды, Финляндия, Великобритания, Турция
const ECS = ['8.8.8.0/24', '85.214.0.0/16', '145.131.0.0/16', '95.216.0.0/16', '81.2.69.0/24', '78.180.0.0/16'];

// Cloudflare (cloudflare.com/ips-v4) и узлы разных его подсетей — кандидаты для сайтов за Cloudflare
const CF_RANGES = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CF_EDGES = ['104.16.123.96', '104.17.24.14', '104.18.32.47', '104.19.128.10', '104.20.20.1', '104.21.48.1', '104.22.0.1', '104.24.0.1',
  '104.25.0.1', '104.26.0.1', '172.64.32.1', '172.66.0.1', '172.67.0.1', '188.114.96.1', '188.114.97.1', '188.114.98.1', '188.114.99.1', '162.159.128.1'];

export const dnsFixFile = () => join(data.state(), 'dnsfix.txt');

/** 'change' (map: Record<blocked, to>) — карта обновилась; её подхватывает локальный DoH-прокси */
export const fixMapEvents = new EventEmitter();

export function fixMapSimple(): Record<string, string> {
  return Object.fromEntries(Object.entries(readMap()).map(([a, e]) => [a, e.to]));
}

export interface FixHostState { host: string; ips: string[]; blocked: string[]; via: 'meta' | 'user' }
export interface FixEntry { to: string; host: string }
export interface DnsFixState { map: Record<string, FixEntry>; hosts: FixHostState[]; unresolved: string[]; updatedAt: number | null }

let last: DnsFixState = { map: {}, hosts: [], unresolved: [], updatedAt: null };
export const dnsFixState = (): DnsFixState => ({ ...last, map: readMap() });

const ip4 = (ip: string) => ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);

function parseRanges(lines: string[]): [number, number][] {
  return lines.map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(l)).map((l) => {
    const [a, b] = l.split('/');
    const mask = Number(b) === 0 ? 0 : (~0 << (32 - Number(b))) >>> 0;
    return [(ip4(a) & mask) >>> 0, mask] as [number, number];
  });
}

function metaRanges(): [number, number][] {
  try {
    return parseRanges(readFileSync(join(res.lists(), 'meta-ranges.txt'), 'utf8').split(/\r?\n/));
  } catch {
    return [];
  }
}
const cfRanges = parseRanges(CF_RANGES);

export function inRanges(ip: string, ranges: [number, number][]) {
  const v = ip4(ip);
  return ranges.some(([n, mask]) => ((v & mask) >>> 0) === n);
}

function tcpTime(ip: string, timeout = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host: ip, port: 443 });
    const done = (v: number | null) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(null));
    s.once('connect', () => done(Date.now() - t0));
    s.once('error', () => done(null));
  });
}

type TlsCheck = 'valid' | 'invalid' | 'unknown';

/** Одна попытка: valid — сертификат на host подтверждён; invalid — сертификат чужой/недействительный; unknown — таймаут или сброс (DPI) */
function tlsCheckOnce(ip: string, host: string, timeout: number): Promise<TlsCheck> {
  return new Promise((resolve) => {
    const s = tls.connect({ host: ip, port: 443, servername: host, ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized: true });
    const done = (v: TlsCheck) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done('unknown'));
    s.once('secureConnect', () => done(s.authorized ? 'valid' : 'invalid'));
    s.once('error', (e: NodeJS.ErrnoException) => done(/CERT|ALTNAME|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME/i.test(`${e.code} ${e.message}`) ? 'invalid' : 'unknown'));
  });
}

/**
 * Доказательство принадлежности: сервер по этому адресу предъявляет действительный сертификат на host.
 * Рукопожатие с заблокированным по SNI сайтом может сорваться из-за DPI (пока автоподбор ищет стратегию),
 * поэтому неопределённый исход повторяем, а отказываем только при настоящей ошибке сертификата.
 */
export async function tlsValidFor(ip: string, host: string, attempts = 3, timeout = 6000): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const r = await tlsCheckOnce(ip, host, timeout);
    if (r !== 'unknown') return r === 'valid';
    await new Promise((res) => setTimeout(res, 1500));
  }
  return false;
}

const withTimeout = <T>(p: Promise<T>, ms: number, def: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(def), ms))]);

async function dohA(host: string, ecs?: string, server: 'google' | 'cloudflare' = 'google'): Promise<string[]> {
  try {
    const url = server === 'google'
      ? `https://dns.google/resolve?name=${host}&type=A${ecs ? `&edns_client_subnet=${ecs}` : ''}`
      : `https://1.1.1.1/dns-query?name=${host}&type=A`;
    const r = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(6000) });
    const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
    return (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {
    return [];
  }
}

function readMap(): Record<string, FixEntry> {
  const f = dnsFixFile();
  if (!existsSync(f)) return {};
  const m: Record<string, FixEntry> = {};
  for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const mm = l.trim().match(/^(\S+)\s+(\S+)(?:\s+#\s*(\S+))?/);
    if (mm && net.isIPv4(mm[1]) && net.isIPv4(mm[2])) m[mm[1]] = { to: mm[2], host: mm[3] ?? '' };
  }
  return m;
}

function writeMap(m: Record<string, FixEntry>) {
  const f = dnsFixFile();
  // Lua читает только первые два адреса строки; «# домен» — для людей и диагностики
  const text = '# z2k-windows: заблокированный IP → рабочий IP (подмена в DNS-ответах, lua z2k-win-dnsfix)\n' +
    Object.entries(m).map(([a, e]) => `${a} ${e.to} # ${e.host}`).join('\n') + '\n';
  writeFileSync(f + '.tmp', text);
  renameSync(f + '.tmp', f);
  fixMapEvents.emit('change', Object.fromEntries(Object.entries(m).map(([a, e]) => [a, e.to])));
}

function flushDnsCache() {
  // Кэш DNS Windows держит старый (заблокированный) ответ до истечения TTL
  execFile('ipconfig', ['/flushdns'], { windowsHide: true }, () => undefined);
}

/** Свои домены: сам домен и www. */
export function userFixHosts(): string[] {
  const out = new Set<string>();
  for (const d of readEntries(userFile(USER_LISTS.ipfix))) {
    out.add(d);
    if (!d.startsWith('www.')) out.add(`www.${d}`);
  }
  return [...out];
}

export async function refreshDnsFix(): Promise<DnsFixState> {
  const meta = metaRanges();
  const prev = readMap();
  const map: Record<string, FixEntry> = {};
  const hosts: FixHostState[] = [];
  const unresolved: string[] = [];
  const reach = new Map<string, Promise<number | null>>();
  const tcp = (ip: string) => {
    if (!reach.has(ip)) reach.set(ip, tcpTime(ip));
    return reach.get(ip)!;
  };

  const jobs: { host: string; via: 'meta' | 'user' }[] = [
    ...(meta.length ? META_HOSTS.map((host) => ({ host, via: 'meta' as const })) : []),
    ...userFixHosts().map((host) => ({ host, via: 'user' as const })),
  ];
  if (!meta.length) log.warn('engine', 'Подмена DNS: нет lists/meta-ranges.txt — домены Meta пропущены');

  await Promise.all(jobs.map(async ({ host, via }) => {
    // «Местный» ответ: системный резолвер (может быть уже подменён движком) + DoH 1.1.1.1
    const local = new Set<string>([
      ...(await withTimeout(dns.resolve4(host).catch(() => [] as string[]), 5000, [])),
      ...(await dohA(host, undefined, 'cloudflare')),
    ]);
    const ips = [...local].filter((ip) => (via === 'meta' ? inRanges(ip, meta) : true));
    const blocked: string[] = [];
    for (const ip of ips) if (!Object.values(map).some((e) => e.to === ip) && (await tcp(ip)) === null) blocked.push(ip);
    hosts.push({ host, ips, blocked, via });
    if (!blocked.length) return;

    const cands = new Set<string>();
    for (const list of await Promise.all(ECS.map((e) => dohA(host, e)))) list.forEach((ip) => cands.add(ip));
    if (blocked.some((ip) => inRanges(ip, cfRanges))) CF_EDGES.forEach((ip) => cands.add(ip));
    const pre = (await Promise.all([...cands].filter((ip) => !blocked.includes(ip) && (via === 'user' || inRanges(ip, meta)))
      .map(async (ip) => ({ ip, t: await tcp(ip) }))))
      .filter((x) => x.t !== null).sort((a, b) => a.t! - b.t!);

    let best: string | null = null;
    if (via === 'meta') best = pre[0]?.ip ?? null;
    else for (const c of pre.slice(0, 8)) if (await tlsValidFor(c.ip, host)) { best = c.ip; break; }

    if (!best) { unresolved.push(host); return; }
    for (const b of blocked) map[b] ??= { to: best, host };
  }));

  // Ранее заблокированные адреса, которых сейчас нет в ответах DNS: оставляем, если они всё ещё недоступны
  await Promise.all(Object.entries(prev).filter(([b]) => !map[b]).map(async ([b, e]) => {
    if ((await tcp(b)) === null && (await tcp(e.to)) !== null) map[b] = e;
  }));

  const key = (m: Record<string, FixEntry>) => JSON.stringify(Object.entries(m).map(([a, e]) => [a, e.to]).sort());
  const changed = key(map) !== key(prev);
  writeMap(map);
  if (changed) flushDnsCache();
  last = { map, hosts: hosts.sort((a, b) => a.host.localeCompare(b.host)), unresolved, updatedAt: Date.now() };
  const n = Object.keys(map).length;
  log.info('engine', n
    ? `Подмена DNS: ${Object.entries(map).map(([a, e]) => `${e.host} ${a}→${e.to}`).join(', ')}${unresolved.length ? `; без рабочей замены: ${unresolved.join(', ')}` : ''}`
    : `Подмена DNS: блокировки по IP не обнаружено${unresolved.length ? ` (без замены: ${unresolved.join(', ')})` : ''}`);
  return last;
}

export function clearDnsFix() {
  writeMap({});
  flushDnsCache();
  last = { map: {}, hosts: [], unresolved: [], updatedAt: null };
}

/** Для диагностики: какие адреса от DNS сейчас недоступны (без изменения чего-либо) */
export async function detectMetaBlocks(): Promise<{ host: string; ip: string | null; reachable: boolean }[]> {
  const list = ['www.instagram.com', 'web.whatsapp.com', 'www.facebook.com', ...readEntries(userFile(USER_LISTS.ipfix)).slice(0, 10)];
  return Promise.all(list.map(async (host) => {
    const ip = (await dohA(host, undefined, 'cloudflare'))[0] ?? null;
    return { host, ip, reachable: ip ? (await tcpTime(ip)) !== null : false };
  }));
}
