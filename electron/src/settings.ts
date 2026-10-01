import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Settings, TgMode } from '../../shared/types';

const TG_MODES: TgMode[] = ['ws', 'warp', 'cfworker', 'relay', 'direct'];
import { data } from './paths';

export const DEFAULT_SETTINGS: Settings = {
  engineAutoStart: true,
  categories: { rkn: true, youtube: true, googlevideo: true, quic: true, discordVoice: true, http: true },
  dynamicTtl: true,
  circularReset: true,
  ipv6: true,
  filterLan: true,
  debugEngine: false,
  dnsFix: true,
  doh: { enabled: true, url: 'https://xbox-dns.ru/dns-query' },
  tg: {
    enabled: true,
    host: '127.0.0.1',
    // 1080 часто попадает в резерв Hyper-V/WSL (EACCES) — по умолчанию 10808, при конфликте прокси подберёт свободный
    port: 10808,
    // WARP: работает и там, где Telegram заблокирован по IP целиком (вместе с фронтом WebSocket)
    mode: 'warp',
    wsFrontIp: '149.154.167.220',
    wsFallbackDirect: true,
    cfWorkerUrl: '',
    cfWorkerSecret: '',
    relayUrl: '',
    relaySecret: '',
    auth: { enabled: false, user: '', pass: '' },
    transparent: true,
  },
  warp: { enabled: false, games: [], fullTunnel: false, transport: 'auto' },
  launchAtLogin: false,
  startMinimized: false,
  closeToTray: true,
  minimizeToTray: true,
  listsAutoUpdate: true,
  listsUpdatedAt: null,
};

function merge<T>(base: T, patch: unknown): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return (patch ?? base) as T;
  if (typeof patch !== 'object' || patch === null) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue; // неизвестные ключи (старые версии) отбрасываем
    out[k] = merge(out[k], v);
  }
  return out as T;
}

class SettingsStore extends EventEmitter {
  private value: Settings = DEFAULT_SETTINGS;

  load(): Settings {
    const file = data.settingsFile();
    try {
      if (existsSync(file)) this.value = merge(DEFAULT_SETTINGS, JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      this.value = DEFAULT_SETTINGS;
    }
    // маршрут, которого в этой версии нет, — иначе прокси работал бы «режим: undefined»
    if (!TG_MODES.includes(this.value.tg.mode)) this.value = { ...this.value, tg: { ...this.value.tg, mode: DEFAULT_SETTINGS.tg.mode } };
    return this.value;
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings> | Record<string, unknown>): Settings {
    const prev = this.value;
    this.value = merge(prev, patch);
    const file = data.settingsFile();
    writeFileSync(file + '.tmp', JSON.stringify(this.value, null, 2));
    renameSync(file + '.tmp', file);
    this.emit('change', this.value, prev);
    return this.value;
  }
}

export const settings = new SettingsStore();
