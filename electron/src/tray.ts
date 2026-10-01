import { Menu, Tray, app, nativeImage } from 'electron';
import { join } from 'node:path';
import { engine } from './engine/winws';
import { tgProxy, tgLink } from './tg/proxy';
import { settings } from './settings';
import { getWindow, createWindow } from './window';
import { shell } from 'electron';
import { warp } from './warp/manager';
import { applyWarp, send } from './ipc';

let tray: Tray | null = null;

function icon(on: boolean) {
  return nativeImage.createFromPath(join(app.getAppPath(), 'build', on ? 'tray-on.png' : 'tray-off.png'));
}

export function showWindow() {
  const w = getWindow() ?? createWindow();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

export function refreshTray() {
  if (!tray) return;
  const running = engine.isRunning();
  const tg = tgProxy.state();
  tray.setImage(icon(running));
  tray.setToolTip(`z2k Windows — обход ${running ? 'включён' : 'выключен'}${tg.running ? `, Telegram-прокси ${tg.listen}` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть z2k', click: showWindow },
    { type: 'separator' },
    {
      label: running ? 'Выключить обход' : 'Включить обход',
      click: () => void (running ? engine.stop() : engine.start(settings.get())),
    },
    {
      label: tg.running ? 'Выключить Telegram-прокси' : 'Включить Telegram-прокси',
      click: () => {
        settings.update({ tg: { ...settings.get().tg, enabled: !tg.running } });
        void (tg.running ? tgProxy.stop() : tgProxy.start(settings.get().tg));
      },
    },
    { label: 'Подключить Telegram к прокси', enabled: tg.running, click: () => void shell.openExternal(tgLink(settings.get().tg)) },
    {
      // Если туннель держит ещё и Telegram («Через WARP»), этот пункт управляет только игровым режимом
      label: (() => { const tg = settings.get().tg; const g = settings.get().warp.enabled; return tg.enabled && tg.mode === 'warp' ? (g ? 'Выключить WARP для игр' : 'Включить WARP для игр') : g ? 'Выключить WARP' : 'Включить WARP'; })(),
      enabled: warp.state.installed,
      click: () => {
        const next = settings.update({ warp: { ...settings.get().warp, enabled: !settings.get().warp.enabled } });
        send('settings', next);
        void applyWarp(next).finally(refreshTray);
      },
    },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  ]));
}

export function createTray() {
  tray = new Tray(icon(false));
  tray.on('click', showWindow);
  engine.on('state', refreshTray);
  tgProxy.on('state', refreshTray);
  // статус WARP приходит каждые 1,5 с — меню перестраиваем только при смене состояния
  let warpKey = '';
  warp.on('state', () => {
    const k = `${warp.state.installed}${warp.state.running}${warp.state.ready}`;
    if (k !== warpKey) { warpKey = k; refreshTray(); }
  });
  refreshTray();
}
