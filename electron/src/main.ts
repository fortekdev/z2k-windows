import { app, dialog } from 'electron';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWindow, getWindow, registerScheme, SCREENSHOT, serveRenderer } from './window';
import { settings } from './settings';
import { log } from './logger';
import { applyWarp, registerIpc, send } from './ipc';
import { warp } from './warp/manager';
import { createTray, showWindow } from './tray';
import { engine } from './engine/winws';
import { ensureUserLists, updateLists } from './engine/lists';
import { ensureStateFile } from './engine/state';
import { tgProxy } from './tg/proxy';
import { tgRedirect } from './tg/redirect';
import { isAdmin } from './system';
import { refreshDnsFix } from './engine/metapins';
import { disableDohSync, initDoh } from './dns/doh';
import { dnsSwitched, restoreDns } from './dns/sysdns';

registerScheme();
app.setAppUserModelId('z2k.windows');

let quitting = false;

if (SCREENSHOT) app.setPath('userData', join(tmpdir(), 'z2k-windows-shot'));

if (!SCREENSHOT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot).catch((e) => {
    dialog.showErrorBox('z2k Windows', String(e?.stack ?? e));
    app.quit();
  });
}

async function boot() {
  const s = settings.load();
  ensureUserLists();
  ensureStateFile();
  serveRenderer();
  registerIpc();
  createTray();

  const autostarted = process.argv.includes('--autostart');
  const win = createWindow();
  if (autostarted && s.startMinimized) win.once('ready-to-show', () => win.hide());

  // Свернуть = спрятать в трей: hide() убирает окно с панели задач, открывается кликом по значку в трее
  win.on('minimize', () => {
    if (settings.get().minimizeToTray) win.hide();
  });

  win.on('close', (e) => {
    if (!quitting && settings.get().closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });

  log.info('app', `z2k Windows ${app.getVersion()} запущен`);
  const admin = await isAdmin();
  if (!admin) log.error('app', 'Нет прав администратора: обход (WinDivert) работать не будет. Перезапустите приложение от имени администратора.');

  if (SCREENSHOT) return;
  // DNS адаптеров остался на 127.0.0.1 после сбоя прошлого запуска — вернуть, пока прокси не поднят
  if (dnsSwitched()) await restoreDns().catch(() => undefined);
  initDoh(() => settings.get());
  if (s.tg.enabled) await tgProxy.start(s.tg).catch(() => undefined);
  if (s.engineAutoStart && admin) await engine.start(s);
  if ((s.warp.enabled || (s.tg.enabled && s.tg.mode === 'warp')) && admin) await applyWarp(s);

  // Подмена заблокированных по IP адресов Meta в DNS-ответах: карта при запуске и раз в 12 часов (адреса Meta меняются)
  const dnsFix = () => {
    if (!settings.get().dnsFix || !admin) return;
    void refreshDnsFix().catch((e: Error) => log.warn('engine', `Подмена DNS для Meta: ${e.message}`));
  };
  dnsFix();
  setInterval(dnsFix, 12 * 3600_000);

  // Списки раз в сутки
  const refresh = async () => {
    const cur = settings.get();
    if (!cur.listsAutoUpdate) return;
    if (cur.listsUpdatedAt && Date.now() - cur.listsUpdatedAt < 24 * 3600_000) return;
    try {
      await updateLists();
      settings.update({ listsUpdatedAt: Date.now() });
      send('settings', settings.get());
      if (engine.isRunning()) await engine.restart(settings.get());
    } catch (e) {
      log.warn('lists', `Автообновление списков не удалось: ${(e as Error).message}`);
    }
  };
  setTimeout(() => void refresh(), 60_000);
  setInterval(() => void refresh(), 3600_000);
}

let warpStopped = false;
app.on('before-quit', (e) => {
  quitting = true;
  // WARP снимаем штатно: маршруты (в т.ч. исключения полного туннеля через физический шлюз) и адаптер
  if (warp.state.running && !warpStopped) {
    e.preventDefault();
    warpStopped = true;
    void warp.stop().finally(() => app.quit());
    return;
  }
  engine.killNow();
  disableDohSync();
  warp.killNow();
  tgRedirect.killNow();
  void tgProxy.stop();
});

app.on('window-all-closed', () => {
  // остаёмся в трее
  if (!settings.get().closeToTray) app.quit();
});

process.on('uncaughtException', (e) => log.error('app', `uncaught: ${e.stack ?? e.message}`));
process.on('unhandledRejection', (e) => log.error('app', `unhandled: ${String((e as Error)?.stack ?? e)}`));

export { getWindow };
