// DoH на время работы обхода: локальный прокси + DNS адаптеров → 127.0.0.1.
// Включается, когда движок запущен, и выключается, когда остановлен. Короткие перезапуски движка
// (смена настроек, подбор стратегии) сглаживаются задержкой, чтобы не дёргать настройки сети.
import type { Settings } from '../../../shared/types';
import { log } from '../logger';
import { engine } from '../engine/winws';
import { fixMapEvents, fixMapSimple } from '../engine/metapins';
import { dohProxy } from './dohproxy';
import { currentDnsServers, dnsSwitched, pointDnsToLocal, restoreDns, restoreDnsSync } from './sysdns';

let active = false;
let busy: Promise<void> = Promise.resolve();
let offTimer: NodeJS.Timeout | null = null;
let getSettings: () => Settings = () => { throw new Error('doh: settings не заданы'); };

function serial(fn: () => Promise<void>) {
  busy = busy.then(fn, fn).catch((e: Error) => log.error('diag', `DoH: ${e.message}`));
  return busy;
}

export function dohState() {
  return { ...dohProxy.stats, active, switched: dnsSwitched() };
}

export function enableDoh(): Promise<void> {
  return serial(async () => {
    const s = getSettings();
    if (!s.doh.enabled) return;
    if (active) return;
    if (dnsSwitched()) await restoreDns(); // хвост прошлого запуска
    const prev = await currentDnsServers();
    dohProxy.setFixMap(s.dnsFix ? fixMapSimple() : {});
    await dohProxy.start(s.doh.url, prev);
    try {
      await pointDnsToLocal();
    } catch (e) {
      await dohProxy.stop();
      throw e;
    }
    active = true;
  });
}

export function disableDoh(): Promise<void> {
  return serial(async () => {
    if (!active && !dnsSwitched()) return;
    await restoreDns();
    await dohProxy.stop();
    active = false;
  });
}

/** Синхронно при выходе из приложения */
export function disableDohSync() {
  restoreDnsSync();
  void dohProxy.stop();
  active = false;
}

export async function restartDoh() {
  await disableDoh();
  if (engine.isRunning()) await enableDoh();
}

export function initDoh(settings: () => Settings) {
  getSettings = settings;
  fixMapEvents.on('change', (m: Record<string, string>) => dohProxy.setFixMap(getSettings().dnsFix ? m : {}));
  engine.on('state', (st: { status: string }) => {
    if (st.status === 'running') {
      if (offTimer) { clearTimeout(offTimer); offTimer = null; }
      void enableDoh();
    } else if (st.status === 'stopped' || st.status === 'error') {
      if (offTimer) clearTimeout(offTimer);
      offTimer = setTimeout(() => { offTimer = null; if (!engine.isRunning()) void disableDoh(); }, 8000);
    }
  });
}
