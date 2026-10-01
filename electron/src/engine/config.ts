// Сборка аргументов winws2 — Windows-аналог S99zapret2 (глобальная часть) + config_official.sh (профили).
// Профили берутся готовыми из генератора z2k, здесь — пути, переключатели, свои стратегии и фильтр WinDivert.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolId, Settings } from '../../../shared/types';
import { cyg, data, res } from '../paths';
import { applyCustom, loadProfiles, mapTokens, parseCustomStrategy, type Profile } from './profiles';
import { hasEntries, USER_LISTS, userFile, whitelistFile, z2kList } from './lists';

// Порядок важен (S99zapret2.new:942-1022): range-rand оборачивает функции antidpi, state-persist — circular из zapret-auto
const LUA_ORDER = [
  'zapret-lib.lua',
  'zapret-antidpi.lua',
  'zapret-auto.lua',
  'z2k-alert.lua',
  'z2k-quic-silence.lua',
  'z2k-tcp16.lua',
  'z2k-fooling-ext.lua',
  'z2k-range-rand.lua',
  'z2k-modern-core.lua',
  'z2k-state-persist.lua',
];

const BLOBS: [string, string][] = [
  ['tls_max_ru', 'tls_clienthello_max_ru.bin'],
  ['tls_clienthello_14', 'tls_clienthello_14.bin'],
  ['tls_clienthello_www_google_com', 'tls_clienthello_www_google_com.bin'],
  ['stun', 'stun.bin'],
  ['tls_clienthello_4pda_to', 'tls_clienthello_4pda_to.bin'],
  ['tls_clienthello_vk_com', 'tls_clienthello_vk_com.bin'],
  ['tls_clienthello_gosuslugi_ru', 'tls_clienthello_gosuslugi_ru.bin'],
  ['tls_clienthello_activated', 'tls_clienthello_activated.bin'],
  ['syn_packet', 'syn_packet.bin'],
  ['quic_google', 'quic_initial_www_google_com.bin'],
  ['quic5', 'quic_5.bin'],
  ['quic4', 'quic_4.bin'],
  ['quic6', 'quic_6.bin'],
  ['quic1', 'quic_1.bin'],
  ['quic_rutracker', 'quic_initial_rutracker_org.bin'],
  ['quic_dbankcloud', 'quic_initial_dbankcloud_ru.bin'],
  ['tls_clienthello_www_onetrust_com', 'tls_clienthello_www_onetrust_com.bin'],
  ['t2', 't2.bin'],
];

// TLS-моды из C-патча форка z2k: upstream winws2 их не знает и откажется стартовать
const FORK_ONLY_TLS_MODS = /^z2k_(grease|alpn_flood|psk|keyshare|earlydata|pha|sct|delegcred)$/;

export const POOLS: { id: PoolId; title: string; description: string; category: keyof Settings['categories'] }[] = [
  { id: 'rkn_tcp', title: 'Заблокированные сайты', description: 'TLS на 443 и CF-портах: список РКН, Discord, свои домены', category: 'rkn' },
  { id: 'yt_tcp', title: 'YouTube', description: 'youtube.com, ytimg и др. по TCP/TLS', category: 'youtube' },
  { id: 'gv_tcp', title: 'YouTube видео', description: 'googlevideo.com — видеопоток по TCP', category: 'googlevideo' },
  { id: 'quic', title: 'QUIC (UDP 443)', description: 'YouTube и заблокированные сайты по QUIC', category: 'quic' },
  { id: 'discord_udp', title: 'Голос Discord', description: 'UDP голос/видео Discord и STUN', category: 'discordVoice' },
  { id: 'http_rkn', title: 'HTTP (порт 80)', description: 'Незашифрованный HTTP к заблокированным сайтам', category: 'http' },
];

export function customFile(pool: PoolId) {
  return join(data.custom(), `${pool}.txt`);
}

export function readCustom(pool: PoolId): string | null {
  const f = customFile(pool);
  if (!existsSync(f)) return null;
  const text = readFileSync(f, 'utf8');
  return parseCustomStrategy(text).length ? text : null;
}

/** @Z2K@/... из генератора → реальные файлы (одна ссылка может развернуться в несколько токенов) */
function resolveListToken(t: string): string[] {
  const m = t.match(/^(--hostlist(?:-exclude)?)=@Z2K@\/(.+)$/);
  if (!m) return [t];
  const [, opt, rel] = m;
  if (rel === 'lists/whitelist.txt') {
    const out = [`${opt}=${cyg(whitelistFile())}`];
    if (hasEntries(userFile(USER_LISTS.excludeDomains))) out.push(`${opt}=${cyg(userFile(USER_LISTS.excludeDomains))}`);
    return out;
  }
  if (rel === 'lists/extra-domains.txt') {
    // свои домены + домены «обхода блокировки по IP»: заблокированный по IP сайт почти всегда режут и по SNI
    return [USER_LISTS.extra, USER_LISTS.ipfix].filter((n) => hasEntries(userFile(n))).map((n) => `${opt}=${cyg(userFile(n))}`);
  }
  return [`${opt}=${cyg(z2kList(rel))}`];
}

function stripForkTlsMods(t: string): string {
  if (!t.startsWith('--lua-desync=') || !t.includes('tls_mod=')) return t;
  return t.replace(/tls_mod=([^:]+)/, (_all, mods: string) => {
    const kept = mods.split(',').filter((m) => !FORK_ONLY_TLS_MODS.test(m));
    return kept.length ? `tls_mod=${kept.join(',')}` : 'tls_mod=none';
  }).replace(/:tls_mod=none/, '');
}

export interface BuiltConfig {
  args: string[];
  pools: PoolId[];
  tcpPorts: string;
  udpPorts: string;
  dnsFix: boolean; // нужен свой фильтр WinDivert: DNS-сервер обычно в локальной сети (роутер), а её фильтр исключает
}

const TCP_PORTS_BY_POOL: Partial<Record<string, string>> = {
  rkn_tcp: '443,2053,2083,2087,2096,8443',
  yt_tcp: '443,2053,2083,2087,2096,8443',
  gv_tcp: '443',
  http_rkn: '80',
  wa_noise: '5222',
};
const UDP_PORTS_BY_POOL: Partial<Record<string, string>> = {
  quic: '443',
  discord_udp: '50000-50099,1400,3478-3481,5349,19294-19344',
};

function joinPorts(list: (string | undefined)[]): string {
  const set = new Set<string>();
  for (const p of list) if (p) for (const x of p.split(',')) set.add(x);
  return [...set].join(',');
}

export function globalArgs(s: Settings, opts: { tcpPorts: string; udpPorts: string; inbound: boolean }): string[] {
  const a: string[] = [];
  if (opts.tcpPorts) a.push(`--wf-tcp-out=${opts.tcpPorts}`);
  if (opts.udpPorts) a.push(`--wf-udp-out=${opts.udpPorts}`);
  // Без входящих данных не работают детекторы автоподбора (inseq, TLS alert, тишина QUIC):
  // в отличие от connbytes на роутере, WinDivert ограничить «первыми N байтами» не умеет
  if (opts.inbound) {
    const tcpIn = opts.tcpPorts.split(',').filter((p) => p !== '5222').join(',');
    if (tcpIn) a.push(`--wf-tcp-in=${tcpIn}`);
    if (opts.udpPorts) a.push(`--wf-udp-in=${opts.udpPorts}`);
  }
  if (!s.ipv6) a.push('--wf-l3=ipv4');
  a.push(`--wf-filter-lan=${s.filterLan ? 1 : 0}`);
  a.push('--ipcache-hostname=1');
  // winws2 понижает права процесса: Lua может писать только в каталог --writable (state.tsv)
  a.push(`--writable=${cyg(data.state())}`);
  if (s.debugEngine) a.push(`--debug=@${cyg(join(data.logs(), 'winws2-debug.log'))}`);
  for (const f of LUA_ORDER) {
    const p = join(res.lua(), f);
    if (existsSync(p)) a.push(`--lua-init=@${cyg(p)}`);
  }
  // Свой Lua приложения (resources/lua-win): подмена заблокированных по IP адресов в DNS-ответах
  const dnsfix = join(res.luaWin(), 'z2k-win-dnsfix.lua');
  if (s.dnsFix && existsSync(dnsfix)) a.push(`--lua-init=@${cyg(dnsfix)}`);
  for (const [name, file] of BLOBS) {
    const p = join(res.fake(), file);
    if (existsSync(p)) a.push(`--blob=${name}:@${cyg(p)}`);
  }
  return a;
}

export function buildProfiles(s: Settings): Profile[] {
  let profiles = loadProfiles(res.profiles());

  const enabledPools = new Set(POOLS.filter((p) => s.categories[p.category]).map((p) => p.id));
  profiles = profiles.filter((p) => {
    if (p.name === 'rkn_template') return enabledPools.has('rkn_tcp');
    if (p.name === 'wa_noise' || p.name === 'unknown') return true;
    return enabledPools.has(p.name);
  });

  // Свои стратегии заменяют пул целиком (автоподбор пула выключается, как в z2k)
  for (const pool of POOLS) {
    const text = readCustom(pool.id);
    if (text && enabledPools.has(pool.id)) profiles = applyCustom(profiles, pool.id, parseCustomStrategy(text));
  }

  const ipExclude = hasEntries(userFile(USER_LISTS.excludeIps)) ? `--ipset-exclude=${cyg(userFile(USER_LISTS.excludeIps))}` : null;

  profiles = mapTokens(profiles, (t) => {
    let x = stripForkTlsMods(t);
    if (!s.dynamicTtl) x = x.replace(/:fool=z2k_dynamic_ttl/g, '');
    if (!s.circularReset && x.startsWith('--lua-desync=circular')) x = x.replace(/:reset(?=:|$)/, '');
    return x;
  });

  return profiles
    .map((p) => {
      const tokens = p.tokens.flatMap(resolveListToken);
      // профиль без единого включающего списка ничего не поймает — но z2k его и не выпускает
      if (ipExclude && p.name !== 'rkn_template') tokens.unshift(ipExclude);
      return { ...p, tokens };
    })
    .filter((p) => {
      const hadHostlist = loadedHadHostlist(p);
      return !hadHostlist || p.tokens.some((t) => t.startsWith('--hostlist='));
    });
}

function loadedHadHostlist(p: Profile) {
  return ['rkn_tcp', 'yt_tcp', 'gv_tcp', 'quic', 'http_rkn'].includes(p.name);
}

export function buildEngineConfig(s: Settings): BuiltConfig {
  const profiles = buildProfiles(s);
  const names = profiles.map((p) => p.name);
  const tcpPorts = joinPorts(names.map((n) => TCP_PORTS_BY_POOL[n]));
  const udpPorts = joinPorts(names.map((n) => UDP_PORTS_BY_POOL[n]));
  const args = [...globalArgs(s, { tcpPorts, udpPorts, inbound: true })];
  profiles.forEach((p, i) => {
    if (i > 0) args.push('--new');
    args.push(...p.tokens);
  });
  const dnsFix = s.dnsFix && existsSync(join(res.luaWin(), 'z2k-win-dnsfix.lua'));
  if (dnsFix) {
    // Входящие DNS-ответы: заблокированный по IP адрес Meta → рабочий (карта — dnsfix.txt в state)
    args.push('--new', '--filter-udp=53', '--filter-l7=dns', '--out-range=x', '--in-range=a', '--payload=dns_response', '--lua-desync=z2k_dns_rewrite');
  }
  return { args, pools: names.filter((n): n is PoolId => POOLS.some((p) => p.id === n)), tcpPorts, udpPorts, dnsFix };
}

// wordexp: одинарные кавычки для всего, где есть пробелы или спецсимволы шелла
export function quoteArg(a: string): string {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

export function writeArgsFile(args: string[], name = 'winws2.args'): string {
  const file = join(data.run(), name);
  writeFileSync(file, args.map(quoteArg).join(' ') + '\n');
  return file;
}

/** C:\a\b → /cygdrive/c/a/b — так winws2 (cygwin) сам передаёт WRITABLE в Lua */
export function cygdrive(p: string): string {
  return cyg(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/cygdrive/${d.toLowerCase()}`);
}

/** Переменные окружения для Lua z2k: где хранить state.tsv (прямые слеши — Lua режет путь по '/') */
export function engineEnv(): NodeJS.ProcessEnv {
  const state = cygdrive(data.state());
  return {
    ...process.env,
    Z2K_STATE_DIR_OVERRIDE: state,
    Z2K_AUTOCIRCULAR_DIR_OVERRIDE: state,
    Z2K_AUTOCIRCULAR_FALLBACK_OVERRIDE: state,
    Z2K_DNSFIX_FILE: `${state}/dnsfix.txt`,
  };
}
