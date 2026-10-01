// Игровой режим WARP (Cloudflare) — Windows-аналог z2k-warp.sh.
// Движок z2k-warpd.exe (порт z2k-warpd: WireGuard по UDP с запасными портами, MASQUE по TCP 443) держит туннель
// на адаптере Wintun «z2k-warp». Маршрутизация — здесь: split-туннель по спискам игр, своим адресам и доменам,
// либо весь трафик компьютера. Мёртвый туннель не держит трафик: пока движок не ready, маршрутов нет.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import dns from 'node:dns/promises';
import type { WarpAccount, WarpSettings, WarpState } from '../../../shared/types';
import { res, data } from '../paths';
import { log } from '../logger';
import { gameEntries, readUser, warpDir } from './lists';
import { TG_CIDRS } from '../tg/proxy';

/** Что заворачивать в туннель: игровой режим (enabled) и/или подсети Telegram (маршрут Telegram «Через WARP») */
export type WarpRunConfig = WarpSettings & { telegram: boolean };

const pexec = promisify(execFile);
const ADAPTER = 'z2k-warp';

// Адреса узлов WARP никогда не заворачиваем в сам туннель
const WARP_EDGE_RANGES = ['162.159.192.0/24', '162.159.193.0/24', '162.159.195.0/24', '162.159.198.0/24', '162.159.204.0/24', '188.114.96.0/21', '188.114.104.0/21'];

export const warpExe = () => join(res.bin(), 'z2k-warpd.exe');
const paths = () => {
  const d = warpDir();
  return { device: join(d, 'device.json'), status: join(d, 'status.json'), log: join(d, 'warpd.log'), netsh: join(d, 'routes.netsh') };
};

interface RawStatus {
  ready?: boolean; transport?: string; endpoint?: string; iface?: string; addr?: string; handshake_age?: number;
  rx?: number; tx?: number; last_error?: string; since?: number; edge_colo?: string; edge_country?: string; edge_rtt_ms?: number;
  if_index?: number; ifIndex?: number; ifindex?: number;
}

const ERRORS: Record<string, string> = {
  register_blocked: 'API Cloudflare недоступен — регистрация устройства не прошла',
  device_revoked: 'Cloudflare отозвал устройство — переустановите WARP',
  no_endpoint: 'Провайдер режет WARP: ни один порт WireGuard и MASQUE не отвечает',
  tun_failed: 'Не удалось создать адаптер Wintun',
  no_transit: 'Туннель поднят, но трафик не идёт',
  addr_conflict: 'Адрес WARP 172.16.0.2 уже занят другим туннелем — запущен клиент Cloudflare WARP (1.1.1.1) или ещё один экземпляр. Отключите его и включите снова.',
};

/** Человеческая причина падения движка по его последним строкам вывода */
export function exitReason(lines: string[], code: number | null): string {
  const text = lines.join('\n');
  for (const [k, v] of Object.entries(ERRORS)) if (text.includes(k)) return v;
  if (/object already exists/i.test(text)) return ERRORS.addr_conflict;
  if (/wintun|Creating adapter|set address/i.test(text)) return `${ERRORS.tun_failed}: ${lines[lines.length - 1] ?? ''}`;
  const last = lines.filter((l) => !/^\d{4}\/\d\d\/\d\d /.test(l)).pop();
  return last ? `Движок завершился: ${last.replace(/^fatal:\s*/, '')}` : `Движок завершился (код ${code})`;
}

/** Процессы z2k-warpd этого приложения, оставшиеся от сбоя (по пути к нашему device.json); чужие не трогаем */
async function killOrphans(devicePath: string) {
  try {
    const needle = devicePath.replace(/'/g, "''");
    await pexec('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='z2k-warpd.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`],
    { windowsHide: true, timeout: 15000 }).then(({ stdout }) => {
      if (stdout.trim()) log.warn('app', `WARP: завершены оставшиеся процессы движка: ${stdout.trim().split(/\s+/).join(', ')}`);
    });
  } catch { /* не критично */ }
}

function normPrefix(p: string) {
  return p.includes('/') ? p : `${p}/32`;
}

function ip4(ip: string) {
  return ip.split('.').reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
}

/** Пересекаются ли два IPv4-префикса */
export function cidrOverlap(a: string, b: string): boolean {
  const [ia, ba] = normPrefix(a).split('/');
  const [ib, bb] = normPrefix(b).split('/');
  const bits = Math.min(Number(ba), Number(bb));
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((ip4(ia) & mask) >>> 0) === ((ip4(ib) & mask) >>> 0);
}

class WarpManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private poll: NodeJS.Timeout | null = null;
  private domainTimer: NodeJS.Timeout | null = null;
  private routed = new Set<string>(); // применённые префиксы через туннель
  private bypassed = new Set<string>(); // исключения через физический шлюз (полный туннель)
  private ifIndex: number | null = null;
  private cfg: WarpRunConfig | null = null;
  private stopping = false;
  private applied = false; // маршруты применены для текущей сессии ready
  private busy = false;
  state: WarpState = { installed: false, registered: false, running: false, ready: false, transport: null, endpoint: null, addr: null, colo: null, rx: 0, tx: 0, handshakeAge: null, routes: 0, error: null, since: null };

  private set(patch: Partial<WarpState>) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  refreshInstalled() {
    this.set({ installed: existsSync(warpExe()) && existsSync(join(res.bin(), 'wintun.dll')), registered: existsSync(paths().device) });
    return this.state;
  }

  async register(): Promise<string> {
    const p = paths();
    try {
      const { stdout } = await pexec(warpExe(), ['register', '--device', p.device], { windowsHide: true, timeout: 90_000 });
      log.info('app', `WARP: ${stdout.trim()}`);
      this.refreshInstalled();
      return stdout.trim();
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      const code = (err.stderr ?? '').trim().split(/\s+/)[0];
      throw new Error(ERRORS[code] ?? (err.stderr?.trim() || err.message));
    }
  }

  /** Сводка об аккаунте (account.json пишет z2k-warpd license; ключ в нём не хранится) */
  account(): WarpAccount {
    const dir = warpDir();
    let a: { account_type?: string; premium_data?: number; quota?: number; checked?: number; error?: string } = {};
    try { a = JSON.parse(readFileSync(join(dir, 'account.json'), 'utf8')); } catch { /* ещё не проверялся */ }
    const plan = (['free', 'limited', 'unlimited', 'team'] as const).find((p) => p === a.account_type) ?? null;
    return {
      plan,
      plus: plan === 'limited' || plan === 'unlimited' || plan === 'team',
      premiumData: a.premium_data ?? 0,
      quota: a.quota ?? 0,
      checked: a.checked ? a.checked * 1000 : null,
      licenseSaved: existsSync(join(dir, 'license')),
      error: a.error || null,
    };
  }

  /**
   * Ключ WARP+ (как z2k-warpd license / wgcf update): привязывает устройство к аккаунту ключа.
   * Ключ передаётся через stdin — в аргументах процесса его видно в списке процессов.
   * Пустой ключ — только перечитать тип аккаунта. Туннель перезапускать не нужно.
   */
  async applyLicense(key: string): Promise<WarpAccount> {
    this.refreshInstalled();
    if (!this.state.installed) throw new Error('Движок WARP не найден');
    if (!this.state.registered) await this.register();
    const k = key.trim();
    if (k && !/^[A-Za-z0-9-]{8,64}$/.test(k)) throw new Error('Ключ WARP+ состоит из латинских букв, цифр и дефисов');
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const child = spawn(warpExe(), ['license', '--device', paths().device], { cwd: res.bin(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let text = '';
      child.stdout?.on('data', (b: Buffer) => { text += b.toString(); });
      child.stderr?.on('data', (b: Buffer) => { text += b.toString(); });
      child.on('error', (e) => resolve({ code: -1, text: e.message }));
      child.on('exit', (code) => resolve({ code, text: text.trim() }));
      child.stdin?.end(k);
    });
    // stderr движка: «license_rejected: <текст Cloudflare>» — код ошибки отрезаем
    const reason = out.text.replace(/^[a-z_]+:\s*/, '');
    switch (out.code) {
      case 0:
        break;
      case 2: throw new Error('Ключ WARP+ состоит из латинских букв, цифр и дефисов');
      case 3: throw new Error(`Cloudflare отклонил ключ: ${reason || 'неверный ключ или исчерпан лимит устройств (до 5 на аккаунт)'}`);
      case 4: throw new Error('Устройство не зарегистрировано — включите WARP один раз');
      default: throw new Error(`API Cloudflare недоступен: ${reason || 'нет ответа'}`);
    }
    const acc = this.account();
    log.info('app', k ? `WARP+: ключ применён, аккаунт ${acc.plan ?? '?'}` : `WARP: тип аккаунта ${acc.plan ?? '?'}`);
    this.emit('account', acc);
    return acc;
  }

  /** Удалить регистрацию устройства (новая установка заведёт новое) */
  async forget() {
    await this.stop();
    rmSync(paths().device, { force: true });
    this.refreshInstalled();
  }

  async start(cfg: WarpRunConfig): Promise<WarpState> {
    this.cfg = cfg;
    if (this.child) {
      await this.applyRoutes();
      return this.state;
    }
    this.refreshInstalled();
    if (!this.state.installed) throw new Error('Движок WARP не найден (resources/bin/z2k-warpd.exe, wintun.dll)');
    if (!this.state.registered) await this.register();
    const p = paths();
    await killOrphans(p.device);
    rmSync(p.status, { force: true });
    this.stopping = false;
    const args = ['run', '--device', p.device, '--status', p.status, '--log', p.log, '--tun-name', ADAPTER, '--transport', cfg.transport];
    const ep = join(res.lists(), 'warp-endpoints.txt');
    const pools = join(res.lists(), 'warp-scan-pools.txt');
    if (existsSync(ep)) args.push('--endpoints', ep);
    if (existsSync(pools)) args.push('--scan-pools', pools);
    log.info('app', `WARP: запуск движка (${cfg.transport})`);
    const child = spawn(warpExe(), args, { cwd: res.bin(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const tail: string[] = [];
    const onOut = (b: Buffer) => b.toString().split(/\r?\n/).filter(Boolean).forEach((l) => {
      tail.push(l);
      if (tail.length > 20) tail.shift();
      log.debug('app', `warpd: ${l}`);
    });
    child.stdout?.on('data', onOut);
    child.stderr?.on('data', onOut);
    child.on('exit', (code) => {
      this.child = null;
      this.clearTimers();
      this.routed.clear();
      this.bypassed.clear();
      this.ifIndex = null;
      const reason = this.stopping ? null : exitReason(tail, code);
      if (reason) log.error('app', `WARP: ${reason}`);
      this.set({ running: false, ready: false, routes: 0, error: reason });
    });
    this.set({ running: true, ready: false, error: null });
    this.poll = setInterval(() => void this.tick(), 1500);
    this.domainTimer = setInterval(() => void this.refreshDomains(), 60_000);
    return this.state;
  }

  private clearTimers() {
    if (this.poll) clearInterval(this.poll);
    if (this.domainTimer) clearInterval(this.domainTimer);
    this.poll = this.domainTimer = null;
  }

  async stop(): Promise<WarpState> {
    const child = this.child;
    this.clearTimers();
    if (!child) return this.state;
    this.stopping = true;
    await this.removeAllRoutes();
    // Движок завершается сам, когда закрыт stdin (снимает туннель и адаптер)
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.stdin?.end();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 6000))]);
    if (this.child?.pid) {
      await pexec('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined);
    }
    log.info('app', 'WARP остановлен');
    return this.state;
  }

  killNow() {
    try { this.child?.stdin?.end(); } catch { /* ignore */ }
  }

  private readStatus(): RawStatus | null {
    try {
      return JSON.parse(readFileSync(paths().status, 'utf8')) as RawStatus;
    } catch {
      return null;
    }
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.tickInner();
    } finally {
      this.busy = false;
    }
  }

  private async tickInner() {
    const st = this.readStatus();
    if (!st) return;
    const ready = !!st.ready;
    this.set({
      ready, transport: st.transport || null, endpoint: st.endpoint || null, addr: st.addr || null,
      colo: st.edge_colo ? `${st.edge_colo}${st.edge_country ? ` · ${st.edge_country}` : ''}${st.edge_rtt_ms ? ` · ${st.edge_rtt_ms} мс` : ''}` : null,
      rx: st.rx ?? 0, tx: st.tx ?? 0, handshakeAge: st.handshake_age ?? null,
      error: st.last_error ? ERRORS[st.last_error] ?? st.last_error : null, since: st.since ? st.since * 1000 : null,
    });
    const idx = st.if_index ?? st.ifIndex ?? st.ifindex ?? null;
    if (idx && idx !== this.ifIndex) {
      this.ifIndex = idx;
      this.routed.clear();
      this.applied = false;
    }
    if (ready && !this.applied) await this.applyRoutes();
    if (!ready && this.applied) {
      log.warn('app', 'WARP: туннель не готов — маршруты сняты, трафик идёт напрямую');
      await this.removeAllRoutes();
    }
  }

  // ---------- маршруты ----------

  private async adapterIndex(): Promise<number | null> {
    if (this.ifIndex) return this.ifIndex;
    try {
      const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-Command', `(Get-NetAdapter -Name '${ADAPTER}' -ErrorAction Stop).ifIndex`], { windowsHide: true, timeout: 15000 });
      const n = Number(stdout.trim());
      this.ifIndex = Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      this.ifIndex = null;
    }
    return this.ifIndex;
  }

  /** Желаемый набор префиксов через туннель */
  private async desiredPrefixes(): Promise<{ prefixes: Set<string>; domains: string[] }> {
    const cfg = this.cfg!;
    const prefixes = new Set<string>();
    const domains: string[] = [];
    if (cfg.enabled && cfg.fullTunnel) {
      prefixes.add('0.0.0.0/1');
      prefixes.add('128.0.0.0/1');
    } else {
      if (cfg.enabled) {
        for (const g of cfg.games) {
          const e = gameEntries(g);
          e.ips.forEach((ip) => prefixes.add(normPrefix(ip)));
          domains.push(...e.domains);
        }
        readUser('ips').forEach((ip) => prefixes.add(normPrefix(ip)));
        domains.push(...readUser('domains'));
      }
      // Telegram заблокирован по IP целиком — его подсети в туннель (только IPv4: адрес WARP у нас v4)
      if (cfg.telegram) TG_CIDRS.filter((c) => !c.includes(':')).forEach((c) => prefixes.add(c));
      for (const ip of await resolveDomains(domains)) prefixes.add(`${ip}/32`);
      // Узлы WARP в туннель не заворачиваем — иначе петля: туннель пошёл бы сам через себя
      const edges = this.edgeRanges();
      const dropped = [...prefixes].filter((p) => edges.some((e) => cidrOverlap(p, e)));
      dropped.forEach((p) => prefixes.delete(p));
      if (dropped.length) log.warn('app', `WARP: исключено ${dropped.length} префиксов, пересекающихся с узлами WARP: ${dropped.slice(0, 5).join(', ')}`);
    }
    return { prefixes, domains };
  }

  /** Встроенные диапазоны узлов WARP + warp-endpoints.txt + warp-scan-pools.txt + текущий endpoint */
  private edgeRanges(): string[] {
    const out = new Set(WARP_EDGE_RANGES);
    for (const f of ['warp-endpoints.txt', 'warp-scan-pools.txt']) {
      try {
        readFileSync(join(res.lists(), f), 'utf8').split(/\r?\n/).map((l) => l.trim())
          .filter((l) => /^\d+\.\d+\.\d+\.\d+(\/\d+)?$/.test(l)).forEach((l) => out.add(normPrefix(l)));
      } catch { /* файла нет — хватит встроенных */ }
    }
    const ep = this.state.endpoint?.split(':')[0];
    if (ep && /^\d+\.\d+\.\d+\.\d+$/.test(ep)) out.add(`${ep}/32`);
    return [...out];
  }

  async applyRoutes() {
    if (!this.child || !this.state.ready || !this.cfg) return;
    const idx = await this.adapterIndex();
    if (!idx) {
      this.set({ error: 'Адаптер z2k-warp не найден — маршруты не применены' });
      return;
    }
    const { prefixes } = await this.desiredPrefixes();
    const lines: string[] = [];
    for (const p of this.routed) if (!prefixes.has(p)) lines.push(`interface ipv4 delete route prefix=${p} interface=${idx} store=active`);
    for (const p of prefixes) if (!this.routed.has(p)) lines.push(`interface ipv4 add route prefix=${p} interface=${idx} nexthop=0.0.0.0 metric=1 store=active`);
    const full = this.cfg.enabled && this.cfg.fullTunnel;
    if (full) lines.push(...(await this.bypassLines()));
    else lines.push(...this.dropBypassLines());
    if (lines.length) await this.netsh(lines);
    this.routed = prefixes;
    this.applied = true;
    this.set({ routes: prefixes.size });
    log.info('app', `WARP: маршрутов через туннель — ${prefixes.size}${full ? ' (весь трафик)' : ''}${this.cfg.telegram ? ', включая Telegram' : ''}`);
  }

  /** Полный туннель: узлы WARP — через физический шлюз, иначе туннель завернёт сам себя */
  private async bypassLines(): Promise<string[]> {
    const gw = await defaultGateway();
    if (!gw) throw new Error('Не найден основной шлюз — полный туннель включать нельзя');
    const want = new Set(this.edgeRanges());
    const lines: string[] = [];
    for (const p of want) if (!this.bypassed.has(p)) lines.push(`interface ipv4 add route prefix=${p} interface=${gw.ifIndex} nexthop=${gw.nextHop} metric=1 store=active`);
    this.bypassed = new Set([...this.bypassed, ...want]);
    return lines;
  }

  private dropBypassLines(): string[] {
    const lines = [...this.bypassed].map((p) => `interface ipv4 delete route prefix=${p} store=active`);
    this.bypassed.clear();
    return lines;
  }

  private async removeAllRoutes() {
    const idx = this.ifIndex;
    const lines = [...this.routed].map((p) => `interface ipv4 delete route prefix=${p}${idx ? ` interface=${idx}` : ''} store=active`);
    lines.push(...this.dropBypassLines());
    this.routed.clear();
    this.applied = false;
    if (lines.length) await this.netsh(lines).catch(() => undefined);
    this.set({ routes: 0 });
  }

  private async netsh(lines: string[]) {
    const f = paths().netsh;
    writeFileSync(f, lines.join('\r\n') + '\r\n');
    // netsh -f выполняет пакет за один запуск (тысячи маршрутов — секунды, а не минуты)
    await pexec('netsh', ['-f', f], { windowsHide: true, timeout: 120_000, maxBuffer: 16 << 20 }).catch((e: { stdout?: string; message: string }) => {
      log.debug('app', `netsh: ${(e.stdout ?? e.message).slice(0, 300)}`);
    });
  }

  /** Домены: свежие адреса из активного резолва и из DNS-кэша Windows (для масок *.domain) */
  private async refreshDomains() {
    if (!this.state.ready || !this.cfg || (this.cfg.enabled && this.cfg.fullTunnel) || this.busy) return;
    this.busy = true;
    try {
      await this.applyRoutes();
    } finally {
      this.busy = false;
    }
  }
}

async function resolveDomains(domains: string[]): Promise<string[]> {
  const exact = domains.filter((d) => !d.startsWith('*.'));
  const wild = domains.filter((d) => d.startsWith('*.')).map((d) => d.slice(1)); // ".example.com"
  const out = new Set<string>();
  await Promise.all(exact.slice(0, 500).map(async (d) => {
    try { (await dns.resolve4(d)).forEach((ip) => out.add(ip)); } catch { /* нет записи */ }
  }));
  if (wild.length || exact.length) {
    for (const { name, ip } of await dnsCache()) {
      const n = name.toLowerCase().replace(/\.$/, '');
      if (wild.some((w) => n.endsWith(w)) || exact.includes(n)) out.add(ip);
    }
  }
  return [...out].filter((ip) => !ip.startsWith('127.') && ip !== '0.0.0.0');
}

/** Пассивное наблюдение: что Windows уже разрешила (DNS-кэш клиента) — аналог DNS-наблюдателя z2k на роутере */
async function dnsCache(): Promise<{ name: string; ip: string }[]> {
  try {
    const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-Command', "Get-DnsClientCache -Type A -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Entry) $($_.Data)\" }"], { windowsHide: true, timeout: 20_000, maxBuffer: 8 << 20 });
    return stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2 && /^\d+\.\d+\.\d+\.\d+$/.test(p[1])).map(([name, ip]) => ({ name, ip }));
  } catch {
    return [];
  }
}

async function defaultGateway(): Promise<{ ifIndex: number; nextHop: string } | null> {
  try {
    const { stdout } = await pexec('powershell.exe', ['-NoProfile', '-Command',
      `Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Where-Object { $_.InterfaceAlias -ne '${ADAPTER}' -and $_.NextHop -ne '0.0.0.0' } | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1 | ForEach-Object { "$($_.ifIndex) $($_.NextHop)" }`],
    { windowsHide: true, timeout: 15000 });
    const [i, hop] = stdout.trim().split(/\s+/);
    return i && hop ? { ifIndex: Number(i), nextHop: hop } : null;
  } catch {
    return null;
  }
}

export const warp = new WarpManager();
export const warpDataDir = () => join(data.root(), 'warp');
