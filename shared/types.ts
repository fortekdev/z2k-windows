// Общие типы main ↔ renderer

export type LogSource = 'app' | 'engine' | 'tg' | 'autopick' | 'lists' | 'diag';

export interface LogEntry {
  id: number;
  ts: number;
  source: LogSource;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
}

export type PoolId = 'rkn_tcp' | 'yt_tcp' | 'gv_tcp' | 'quic' | 'discord_udp' | 'http_rkn';

export interface PoolInfo {
  id: PoolId;
  title: string;
  description: string;
  strategies: number; // число стратегий в автоподборе
  custom: boolean; // задана своя строка — автоподбор пула выключен
  enabled: boolean;
}

export interface Settings {
  // Обход (winws2)
  engineAutoStart: boolean;
  categories: { rkn: boolean; youtube: boolean; googlevideo: boolean; quic: boolean; discordVoice: boolean; http: boolean };
  dynamicTtl: boolean;
  circularReset: boolean;
  ipv6: boolean;
  filterLan: boolean;
  debugEngine: boolean;
  dnsFix: boolean;
  doh: { enabled: boolean; url: string }; // DNS через DoH на время работы обхода (локальный прокси 127.0.0.1) // подмена заблокированных по IP адресов Meta в DNS-ответах (движок, без правки hosts)
  // Telegram
  tg: TgSettings;
  // Игровой режим WARP (Cloudflare)
  warp: WarpSettings;
  // Приложение
  launchAtLogin: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  minimizeToTray: boolean; // свёрнутое окно убирается с панели задач, остаётся только значок в трее
  listsAutoUpdate: boolean;
  listsUpdatedAt: number | null;
}

export type TgMode = 'ws' | 'warp' | 'cfworker' | 'relay' | 'direct';

export interface TgSettings {
  enabled: boolean;
  host: string;
  port: number;
  mode: TgMode; // ws — через WebSocket Telegram Web; warp — подсети Telegram маршрутами в туннель WARP; cfworker — свой Cloudflare Worker; relay — свой VPS с z2k-vps-relay; direct — прямой TCP
  wsFrontIp: string; // IP фронта web.telegram.org, к которому подключаемся с SNI kwsN
  wsFallbackDirect: boolean;
  cfWorkerUrl: string; // wss://<имя>.<поддомен>.workers.dev/ws
  cfWorkerSecret: string;
  relayUrl: string; // wss://<IP>.nip.io/ws — свой VPS с релеем z2k (resources/vps-relay/install.sh)
  relaySecret: string;
  auth: { enabled: boolean; user: string; pass: string };
  transparent: boolean; // прозрачный перехват: Telegram без настроек прокси и веб-версия идут через прокси сами (WinDivert, как REDIRECT в z2k)
}

export type EngineStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface EngineState {
  status: EngineStatus;
  pid: number | null;
  startedAt: number | null;
  lastError: string | null;
  version: string | null;
  argsCount: number;
}

export interface TgDcStat {
  dc: string; // "2", "4m" (media) …
  active: number;
  total: number;
  bytesUp: number;
  bytesDown: number;
  lastError: string | null;
}

export interface TgState {
  running: boolean;
  listen: string | null;
  mode: TgMode;
  connections: number;
  totalConnections: number;
  bytesUp: number;
  bytesDown: number;
  dcs: TgDcStat[];
  lastError: string | null;
  transparent: TgRedirectState;
}

export interface TgRedirectState {
  running: boolean;
  active: number; // перехваченных соединений сейчас
  error: string | null;
}

export interface StateRow {
  pool: string;
  host: string;
  strategy: number;
  ts: number;
  pinned: boolean; // заморожено оператором
  family: string;
  raw: string[];
}

export interface StrategyEntry {
  pool: PoolId;
  index: number; // strategy=N
  lines: string[]; // --lua-desync=... без strategy=N
}

export type ProbeStage = 'dns' | 'tcp' | 'tls' | 'http';

export interface ProbeResult {
  host: string;
  ips: string[];
  stages: { stage: ProbeStage; ok: boolean; ms: number; detail: string }[];
  verdict: 'ok' | 'dns_blocked' | 'tcp_blocked' | 'tls_blocked' | 'http_blocked' | 'cutoff16k' | 'error';
  verdictText: string;
  bytes: number;
  inLists: string[];
}

export interface AutopickJob {
  id: string;
  pool: PoolId;
  host: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  tested: number;
  total: number;
  current: number | null;
  found: number[]; // рабочие номера стратегий
  results: { strategy: number; ok: boolean; ms: number; detail: string }[];
  baseline: ProbeResult | null;
  startedAt: number;
  finishedAt: number | null;
  applied: number | null;
  error: string | null;
}

export interface ListInfo {
  id: string;
  title: string;
  file: string;
  editable: boolean;
  count: number;
  description: string;
}

export interface SystemCheck {
  id: string;
  title: string;
  ok: boolean | null;
  detail: string;
  fix?: string; // id действия для исправления
}

export interface AppInfo {
  version: string;
  isAdmin: boolean;
  engine: { winws2: string; luaCore: string; z2k: string } | null;
  dataDir: string;
  platform: string;
}

export interface Snapshot {
  engine: EngineState;
  tg: TgState;
  warp: WarpState;
  settings: Settings;
}

export interface WarpSettings {
  enabled: boolean;
  games: string[]; // id списков игр (YOZH3G/ru-gaming-blocklist)
  fullTunnel: boolean; // весь трафик компьютера через WARP
  transport: 'auto' | 'wg' | 'h2';
}

export interface WarpState {
  installed: boolean;
  registered: boolean;
  running: boolean;
  ready: boolean;
  transport: string | null;
  endpoint: string | null;
  addr: string | null;
  colo: string | null;
  rx: number;
  tx: number;
  handshakeAge: number | null;
  routes: number;
  error: string | null;
  since: number | null;
}

export interface WarpAccount {
  plan: 'free' | 'limited' | 'unlimited' | 'team' | null; // account_type от Cloudflare (null — ещё не проверялся)
  plus: boolean; // оплаченный аккаунт: WARP+, Unlimited или Zero Trust
  premiumData: number; // остаток трафика WARP+, байт
  quota: number; // квота, байт
  checked: number | null; // когда проверялось (мс)
  licenseSaved: boolean;
  error: string | null; // ключ сохранён, но к устройству не привязался
}
