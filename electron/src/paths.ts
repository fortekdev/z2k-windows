import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Ресурсы движка (только чтение): в dev — ./resources, в сборке — <resources>/engine
export function resourcesDir(): string {
  const packed = join(process.resourcesPath ?? '', 'engine');
  if (app.isPackaged && existsSync(packed)) return packed;
  return join(app.getAppPath(), 'resources');
}

export const res = {
  bin: () => join(resourcesDir(), 'bin'),
  winws: () => join(resourcesDir(), 'bin', 'winws2.exe'),
  tgredir: () => join(resourcesDir(), 'bin', 'z2k-tgredir.exe'),
  lua: () => join(resourcesDir(), 'lua'),
  luaWin: () => join(resourcesDir(), 'lua-win'), // свой Lua приложения (не перезаписывается fetch-engine)
  fake: () => join(resourcesDir(), 'fake'),
  lists: () => join(resourcesDir(), 'lists'),
  strategies: () => join(resourcesDir(), 'strategies'),
  profiles: () => join(resourcesDir(), 'strategies', 'z2k-profiles.txt'),
  versionFile: () => join(resourcesDir(), 'engine-version.json'),
};

function ensure(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Рабочие данные — в %ProgramData%\z2k-windows: приложение работает от администратора,
// а путь без пробелов/кириллицы из имени пользователя надёжнее для cygwin-сборки winws2.
function root(): string {
  return ensure(join(process.env.ProgramData ?? 'C:\\ProgramData', 'z2k-windows'));
}

export const data = {
  root,
  state: () => ensure(join(root(), 'state')),
  lists: () => ensure(join(root(), 'lists')),
  logs: () => ensure(join(root(), 'logs')),
  run: () => ensure(join(root(), 'run')),
  custom: () => ensure(join(root(), 'custom-strategies')),
  settingsFile: () => join(root(), 'settings.json'),
};

/** Путь для аргументов winws2 (cygwin): прямые слеши */
export function cyg(p: string): string {
  return p.replace(/\\/g, '/');
}
