import { BrowserWindow, Menu, app, net, protocol, shell } from 'electron';
import { join, normalize, extname } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEV = process.env.Z2K_DEV === '1';
// Отладка UI: Z2K_SCREENSHOT=<png> [Z2K_VIEW=<раздел>] — открыть окно, сохранить снимок и выйти
export const SCREENSHOT = process.env.Z2K_SCREENSHOT ?? null;
const DEV_URL = 'http://localhost:3123';

// Схема app:// для статического экспорта Next.js — должна быть зарегистрирована до ready
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

function rendererRoot(): string {
  return join(app.getAppPath(), 'renderer', 'out');
}

export function serveRenderer() {
  const root = rendererRoot();
  protocol.handle('app', (req) => {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
    if (!extname(file) && existsSync(file + '.html')) file += '.html';
    if (!existsSync(file)) file = join(root, 'index.html');
    return net.fetch(pathToFileURL(file).toString());
  });
}

let win: BrowserWindow | null = null;

export function getWindow() {
  return win;
}

export function createWindow(): BrowserWindow {
  // Верхнее меню не нужно ни в dev, ни в сборке
  Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0d1117',
    title: 'z2k Windows — Создано в RuBot.Cloud',
    icon: join(app.getAppPath(), 'build', 'icon.ico'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    // 39, а не 40: шапка — 40px с границей на последнем пикселе, зона кнопок не должна её перекрывать
    titleBarOverlay: { color: '#0d1117', symbolColor: '#8b98a8', height: 39 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      spellcheck: false,
    },
  });
  win.setMenu(null);

  // DevTools отключены: devTools:false + глушим горячие клавиши и перезагрузку страницы
  win.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase();
    const ctrlShift = input.control && input.shift;
    if (key === 'f12' || (ctrlShift && (key === 'i' || key === 'j' || key === 'c')) || (input.control && key === 'r') || key === 'f5') {
      event.preventDefault();
    }
  });
  win.webContents.on('devtools-opened', () => win?.webContents.closeDevTools());

  // Внешние ссылки — в системный браузер, tg:// — в Telegram
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|tg):/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = DEV ? url.startsWith(DEV_URL) : url.startsWith('app://');
    if (!allowed) {
      e.preventDefault();
      if (/^(https?|tg):/i.test(url)) void shell.openExternal(url);
    }
  });

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = null; });

  void loadUi(win);
  return win;
}

async function loadUi(w: BrowserWindow) {
  const hash = process.env.Z2K_VIEW ? `#${process.env.Z2K_VIEW}` : '';
  if (SCREENSHOT) {
    w.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        const img = await w.webContents.capturePage();
        writeFileSync(SCREENSHOT, img.toPNG());
        console.log(`screenshot: ${SCREENSHOT} ${img.getSize().width}x${img.getSize().height}`);
      } catch (e) {
        console.error('screenshot failed', e);
      }
      app.exit(0);
    }, 2500));
  }
  if (!DEV) {
    await w.loadURL(`app://local/index.html${hash}`);
    return;
  }
  // В dev Next.js может ещё компилироваться — повторяем, пока сервер не ответит
  for (let i = 0; i < 120; i++) {
    try {
      await w.loadURL(DEV_URL + hash);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
