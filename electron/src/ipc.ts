// Команды renderer → main (белый список) и события main → renderer
import { app, ipcMain, shell } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppInfo, PoolId, PoolInfo, Settings } from '../../shared/types';
import { data, res, resourcesDir } from './paths';
import { log } from './logger';
import { settings } from './settings';
import { getWindow } from './window';
import { engine, dryRun } from './engine/winws';
import { buildEngineConfig, customFile, POOLS, readCustom } from './engine/config';
import { circularLine, loadProfiles, parseCustomStrategy, strategyLines, strategyNumbers } from './engine/profiles';
import { deleteRow, readState, resetPool, setFrozen, setStrategy } from './engine/state';
import { listInfos, normalizeDomain, readList, updateLists, whereListed, writeUserList } from './engine/lists';
import { autopick, AUTOPICK_POOLS, DEFAULT_TARGETS } from './autopick/autopick';
import { probe } from './autopick/probe';
import { tgLink, tgProxy } from './tg/proxy';
import { probeDc } from './tg/selftest';
import { deployWorker, newSecret, workerSource } from './tg/cfdeploy';
import { warp } from './warp/manager';
import { clearDnsFix, dnsFixState, refreshDnsFix } from './engine/metapins';
import { dohState, restartDoh } from './dns/doh';
import { gameEntries, listGames, readUser, updateGames, writeUser } from './warp/lists';
import { isAdmin, killForeign, runChecks, setAutostart, setTcpTimestamps } from './system';

export function send(event: string, payload: unknown) {
  const w = getWindow();
  if (w && !w.isDestroyed()) w.webContents.send('z2k:event', event, payload);
}

function engineVersionInfo(): AppInfo['engine'] {
  try {
    const j = JSON.parse(readFileSync(res.versionFile(), 'utf8'));
    return { winws2: j.winws2, luaCore: j.luaCore, z2k: j.z2k };
  } catch {
    return null;
  }
}

function poolInfos(): PoolInfo[] {
  const s = settings.get();
  const profiles = loadProfiles(res.profiles());
  return POOLS.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    strategies: strategyNumbers(profiles, p.id).length,
    custom: readCustom(p.id) !== null,
    enabled: s.categories[p.category],
  }));
}

async function restartEngineIfRunning() {
  if (engine.isRunning()) await engine.restart(settings.get());
}

/** Проверить свою строку целиком в составе полной конфигурации (как «Проверить» в панели z2k) */
async function validateCustom(pool: PoolId, text: string) {
  const f = customFile(pool);
  const prev = existsSync(f) ? readFileSync(f, 'utf8') : null;
  writeFileSync(f, text);
  try {
    return await dryRun(buildEngineConfig(settings.get()).args);
  } finally {
    if (prev === null) rmSync(f, { force: true });
    else writeFileSync(f, prev);
  }
}

async function diagReport(): Promise<string> {
  const s = settings.get();
  const checks = await runChecks();
  const st = readState();
  const lines = [
    `z2k Windows ${app.getVersion()} · ${new Date().toISOString()}`,
    `Движок: ${engine.state.status}${engine.state.version ? ` · ${engine.state.version}` : ''}${engine.state.lastError ? ` · ошибка: ${engine.state.lastError}` : ''}`,
    `Telegram-прокси: ${tgProxy.state().running ? `${tgProxy.state().listen} (${s.tg.mode})` : 'выключен'}`,
    `Прозрачный перехват Telegram: ${tgProxy.state().transparent.running ? `работает, соединений ${tgProxy.state().transparent.active}` : s.tg.transparent ? `не работает${tgProxy.state().transparent.error ? ` (${tgProxy.state().transparent.error})` : ''}` : 'выключен'}`,
    `Категории: ${Object.entries(s.categories).filter(([, v]) => v).map(([k]) => k).join(', ')}`,
    '',
    'Проверки:',
    ...checks.map((c) => `  [${c.ok === true ? 'OK' : c.ok === false ? '!!' : '??'}] ${c.title}: ${c.detail}`),
    '',
    `Автоподбор (${st.length} записей):`,
    ...st.slice(0, 40).map((r) => `  ${r.pool.padEnd(12)} ${r.host.padEnd(32)} #${r.strategy}${r.pinned ? ' (заморожено)' : ''}`),
    '',
    'Последние ошибки:',
    ...log.tail(undefined, 3000).filter((e) => e.level === 'error' || e.level === 'warn').slice(-30).map((e) => `  ${new Date(e.ts).toLocaleTimeString()} [${e.source}] ${e.msg}`),
  ];
  return lines.join('\n');
}

type Handler = (...args: never[]) => unknown;

const handlers: Record<string, Handler> = {
  'app:info': async (): Promise<AppInfo> => ({ version: app.getVersion(), isAdmin: await isAdmin(), engine: engineVersionInfo(), dataDir: data.root(), platform: `${process.platform} ${process.arch}` }),
  'app:snapshot': () => ({ engine: engine.state, tg: tgProxy.state(), warp: warp.refreshInstalled(), settings: settings.get() }),
  'app:openData': () => shell.openPath(data.root()),
  'app:openExternal': (url: string) => (/^(https?|tg):/i.test(url) ? shell.openExternal(url) : undefined),
  'app:quit': () => app.quit(),

  'settings:get': () => settings.get(),
  'settings:update': async (patch: Partial<Settings>) => {
    const prev = settings.get();
    const next = settings.update(patch);
    if (JSON.stringify(prev.launchAtLogin) !== JSON.stringify(next.launchAtLogin)) await setAutostart(next.launchAtLogin);
    const engineKeys: (keyof Settings)[] = ['categories', 'dynamicTtl', 'circularReset', 'ipv6', 'filterLan', 'debugEngine', 'dnsFix'];
    if (prev.dnsFix !== next.dnsFix) {
      if (next.dnsFix) void refreshDnsFix().catch((e: Error) => log.warn('engine', `Подмена DNS для Meta: ${e.message}`));
      else clearDnsFix();
    }
    if (engineKeys.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]))) await restartEngineIfRunning();
    const tgWarp = (x: Settings) => x.tg.enabled && x.tg.mode === 'warp';
    if (JSON.stringify(prev.warp) !== JSON.stringify(next.warp) || tgWarp(prev) !== tgWarp(next)) await applyWarp(next);
    if (JSON.stringify(prev.doh) !== JSON.stringify(next.doh)) await restartDoh();
    if (JSON.stringify(prev.tg) !== JSON.stringify(next.tg)) {
      if (next.tg.enabled) await tgProxy.start(next.tg).catch(() => undefined);
      else await tgProxy.stop();
    }
    send('settings', next);
    return next;
  },

  'engine:start': () => engine.start(settings.get()),
  'engine:stop': () => engine.stop(),
  'engine:restart': () => engine.restart(settings.get()),
  'engine:args': () => buildEngineConfig(settings.get()).args,
  'engine:dryrun': () => dryRun(buildEngineConfig(settings.get()).args),

  'pools:list': () => poolInfos(),
  'pools:strategy': (pool: PoolId, n: number) => strategyLines(loadProfiles(res.profiles()), pool, n),
  'pools:circular': (pool: PoolId) => circularLine(loadProfiles(res.profiles()), pool),
  'custom:get': (pool: PoolId) => readCustom(pool) ?? '',
  'custom:validate': (pool: PoolId, text: string) => {
    if (!parseCustomStrategy(text).length) return { ok: false, output: 'Строка пуста' };
    return validateCustom(pool, text);
  },
  'custom:save': async (pool: PoolId, text: string) => {
    const check = await validateCustom(pool, text);
    if (!check.ok) return check;
    writeFileSync(customFile(pool), text);
    log.info('engine', `Своя стратегия для ${pool} сохранена`);
    await restartEngineIfRunning();
    return check;
  },
  'custom:delete': async (pool: PoolId) => {
    rmSync(customFile(pool), { force: true });
    log.info('engine', `${pool}: возвращён автоподбор`);
    await restartEngineIfRunning();
  },

  'state:list': () => readState(),
  'state:set': (pool: string, host: string, family: string, n: number) => setStrategy(pool, host, family, n),
  'state:freeze': (pool: string, host: string, family: string, frozen: boolean) => setFrozen(pool, host, family, frozen),
  'state:delete': (pool: string, host: string, family: string) => deleteRow(pool, host, family),
  'state:reset': (pool: string | null) => resetPool(pool),

  'autopick:pools': () => AUTOPICK_POOLS.map((p) => ({ pool: p, target: DEFAULT_TARGETS[p] })),
  'autopick:run': (req: Parameters<typeof autopick.run>[0]) => {
    void autopick.run(req, settings.get());
    return true;
  },
  'autopick:cancel': () => autopick.cancel(),
  'autopick:current': () => autopick.current(),

  'lists:info': () => listInfos(),
  'lists:read': (id: string) => readList(id),
  'lists:write': async (id: string, entries: string[]) => {
    const r = writeUserList(id, entries);
    // Хостлисты winws2 читает при старте; адресные исключения — тоже
    await restartEngineIfRunning();
    // Новые домены «обхода блокировки по IP» — сразу ищем им замену (карту движок перечитывает сам)
    if (id === 'ipfix' && settings.get().dnsFix) void refreshDnsFix().catch((e: Error) => log.warn('engine', `Подмена DNS: ${e.message}`));
    return r;
  },
  'lists:where': (domain: string) => {
    const d = normalizeDomain(domain);
    return d ? whereListed(d) : [];
  },
  'lists:update': async () => {
    const r = await updateLists();
    settings.update({ listsUpdatedAt: Date.now() });
    send('settings', settings.get());
    await restartEngineIfRunning();
    return r;
  },

  'probe:run': async (host: string) => {
    const r = await probe(host, { dohCompare: true });
    const d = normalizeDomain(host);
    r.inLists = d ? whereListed(d) : [];
    return r;
  },

  'tg:state': () => tgProxy.state(),
  'tg:start': async () => {
    settings.update({ tg: { ...settings.get().tg, enabled: true } });
    send('settings', settings.get());
    const st = await tgProxy.start(settings.get().tg);
    if (settings.get().tg.mode === 'warp') await applyWarp(settings.get());
    return st;
  },
  'tg:stop': async () => {
    const wasWarp = settings.get().tg.mode === 'warp';
    settings.update({ tg: { ...settings.get().tg, enabled: false } });
    send('settings', settings.get());
    await tgProxy.stop();
    if (wasWarp) await applyWarp(settings.get());
  },
  'tg:link': () => tgLink(settings.get().tg),
  'tg:connect': () => shell.openExternal(tgLink(settings.get().tg)),
  'tg:cf-source': () => workerSource(),
  'tg:relay-dir': () => join(resourcesDir(), 'vps-relay'),
  'tg:relay-open': () => shell.openPath(join(resourcesDir(), 'vps-relay')),
  'tg:cf-secret': () => newSecret(),
  'tg:cf-deploy': async (token: string) => {
    const r = await deployWorker(token);
    const tg = { ...settings.get().tg, mode: 'cfworker' as const, cfWorkerUrl: r.url, cfWorkerSecret: r.secret };
    settings.update({ tg });
    send('settings', settings.get());
    if (tg.enabled) await tgProxy.start(tg);
    return { url: r.url, account: r.account };
  },
  'tg:selftest': async () => {
    const tg = settings.get().tg;
    if (!tgProxy.state().running) throw new Error('Прокси выключен');
    const host = tg.host === '0.0.0.0' ? '127.0.0.1' : tg.host;
    const auth = tg.auth.enabled ? { user: tg.auth.user, pass: tg.auth.pass } : undefined;
    return Promise.all([1, 2, 3, 4, 5, -2, -4].map((dc) => probeDc(tg.port, dc, host, auth)));
  },

  'warp:state': () => warp.refreshInstalled(),
  'warp:register': () => warp.register(),
  'warp:forget': () => warp.forget(),
  'warp:account': () => warp.account(),
  'warp:license': (key: string) => warp.applyLicense(key),
  'warp:games': () => listGames(),
  'warp:game': (id: string) => gameEntries(id),
  'warp:games-update': () => updateGames(),
  'warp:user-read': (kind: 'ips' | 'domains') => readUser(kind),
  'warp:user-write': async (kind: 'ips' | 'domains', entries: string[]) => {
    const r = writeUser(kind, entries);
    if (warp.state.running) await warp.applyRoutes();
    return r;
  },

  'doh:state': () => dohState(),
  'dnsfix:state': () => dnsFixState(),
  'dnsfix:refresh': () => refreshDnsFix(),

  'diag:checks': () => runChecks(),
  'diag:fix': async (id: string) => {
    if (id === 'tcp-timestamps') await setTcpTimestamps(true);
    else if (id === 'kill-foreign') await killForeign();
    else if (id === 'dnsfix-refresh') await refreshDnsFix();
    return runChecks();
  },
  'diag:report': () => diagReport(),

  'logs:tail': (source?: string) => log.tail(source as never, 1500),
};

/** Включение/выключение и смена списков WARP по настройкам */
export async function applyWarp(s: Settings) {
  // Туннель нужен игровому режиму и/или маршруту Telegram «Через WARP»
  const telegram = s.tg.enabled && s.tg.mode === 'warp';
  if (!s.warp.enabled && !telegram) {
    await warp.stop();
    return;
  }
  try {
    await warp.start({ ...s.warp, telegram });
  } catch (e) {
    log.error('app', `WARP: ${(e as Error).message}`);
    warp.state.error = (e as Error).message;
    send('warp', warp.state);
  }
}

export function registerIpc() {
  ipcMain.handle('z2k', async (_e, channel: string, ...args: unknown[]) => {
    const h = handlers[channel];
    if (!h) throw new Error(`Неизвестная команда ${channel}`);
    return (h as (...a: unknown[]) => unknown)(...args);
  });

  log.on('entry', (e) => send('log', e));
  engine.on('state', (s) => send('engine', s));
  tgProxy.on('state', (s) => send('tg', s));
  // прокси сам переехал на свободный порт (исходный зарезервирован Windows) — запоминаем, чтобы ссылка для Telegram совпадала
  tgProxy.on('port-changed', (port: number) => {
    settings.update({ tg: { ...settings.get().tg, port } });
    send('settings', settings.get());
  });
  autopick.on('job', (j) => send('autopick', j));
  warp.on('state', (w) => send('warp', w));
}
