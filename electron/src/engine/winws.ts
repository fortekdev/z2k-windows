// Управление процессом winws2.exe (аналог S99zapret2 start/stop/status)
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EngineState, Settings } from '../../../shared/types';
import { cyg, data, res } from '../paths';
import { log } from '../logger';
import { buildEngineConfig, engineEnv, writeArgsFile } from './config';

const pexec = promisify(execFile);

export interface RunOptions {
  args: string[];
  argsFile: string;
  onLine?: (line: string) => void;
}

/** Запуск winws2 с @-файлом аргументов. Резолвится, когда WinDivert поднялся, или реджектится с причиной. */
export function spawnWinws(opts: RunOptions): Promise<ChildProcess> {
  const exe = res.winws();
  if (!existsSync(exe)) return Promise.reject(new Error(`Не найден ${exe}. Выполните npm run fetch:engine`));
  const file = writeArgsFile(opts.args, opts.argsFile);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [`@${file}`], { cwd: res.bin(), env: engineEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail: string[] = [];
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(child);
    };
    const onData = (buf: Buffer) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 30) tail.shift();
        opts.onLine?.(line);
        if (/windivert initialized/i.test(line)) done();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => done(e));
    child.on('exit', (code) => done(new Error(`winws2 завершился с кодом ${code}: ${tail.slice(-6).join(' | ') || 'без вывода'}`)));
    // Если строка «windivert initialized» не пришла (другая версия) — считаем живой процесс запущенным
    const timer = setTimeout(() => (child.exitCode === null ? done() : undefined), 6000);
  });
}

/**
 * Фильтр WinDivert со своей веткой DNS: штатный фильтр (с исключением локальной сети) получаем у самого winws2
 * через --wf-save и добавляем к нему по ИЛИ запросы/ответы порта 53 — DNS-сервер обычно роутер в локальной сети.
 * --wf-raw winws2 использует как есть, без своих добавок.
 */
export async function withDnsFilter(args: string[]): Promise<string[]> {
  const isWf = (a: string) => /^--wf-(tcp|udp|raw-part|tcp-empty|l3|filter-lan|filter-loopback)/.test(a);
  const wf = args.filter(isWf);
  const base = join(data.run(), 'windivert.base.txt');
  const full = join(data.run(), 'windivert.txt');
  rmSync(base, { force: true }); // старый файл от прошлого запуска не должен сойти за свежий
  try {
    await pexec(res.winws(), [...wf, `--wf-save=${cyg(base)}`], { cwd: res.bin(), windowsHide: true, timeout: 15000 });
  } catch { /* --wf-save завершает процесс сразу после записи — код возврата не важен */ }
  if (!existsSync(base)) {
    log.warn('engine', 'Не удалось получить фильтр WinDivert — подмена DNS для Meta в этом запуске не работает');
    return args;
  }
  const dns = '!impostor and !loopback and udp and (outbound and udp.DstPort == 53 or inbound and udp.SrcPort == 53)';
  writeFileSync(full, `(\n${readFileSync(base, 'utf8').trim()}\n)\nor\n(${dns})\n`);
  return [`--wf-raw=@${cyg(full)}`, ...args.filter((a) => !isWf(a))];
}

export async function killTree(pid: number) {
  try {
    await pexec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } catch { /* уже завершён */ }
}

export async function winwsVersion(): Promise<string | null> {
  try {
    const { stdout } = await pexec(res.winws(), ['--version'], { cwd: res.bin(), windowsHide: true, timeout: 5000 });
    return stdout.trim().split(/\r?\n/)[0] ?? null;
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    return out?.trim().split(/\r?\n/)[0] ?? null;
  }
}

/** Проверка набора аргументов движком без перехвата (--dry-run), как «Проверить» в панели z2k */
export async function dryRun(args: string[]): Promise<{ ok: boolean; output: string }> {
  const file = writeArgsFile(['--dry-run', ...args], 'winws2.dryrun.args');
  try {
    const { stdout, stderr } = await pexec(res.winws(), [`@${file}`], { cwd: res.bin(), env: engineEnv(), windowsHide: true, timeout: 30_000 });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: ((err.stdout ?? '') + (err.stderr ?? '')).trim() || err.message };
  }
}

/** Все запущенные winws/winws2/goodbyedpi — конфликтуют за WinDivert */
export async function listForeignEngines(): Promise<{ pid: number; name: string }[]> {
  try {
    const { stdout } = await pexec('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .map((l) => l.split('","').map((x) => x.replace(/"/g, '')))
      .filter((c) => c.length > 1 && /^(winws2?|goodbyedpi|zapret)\.exe$/i.test(c[0]))
      .map((c) => ({ name: c[0], pid: Number(c[1]) }));
  } catch {
    return [];
  }
}

class Engine extends EventEmitter {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private crashes: number[] = [];
  state: EngineState = { status: 'stopped', pid: null, startedAt: null, lastError: null, version: null, argsCount: 0 };

  private set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  isRunning() {
    return this.state.status === 'running';
  }

  async start(s: Settings): Promise<EngineState> {
    if (this.child) return this.state;
    this.stopping = false;
    this.set({ status: 'starting', lastError: null });
    try {
      const version = this.state.version ?? (await winwsVersion());
      const cfg = buildEngineConfig(s);
      log.info('engine', `Запуск winws2: пулы ${cfg.pools.join(', ')}; TCP ${cfg.tcpPorts}; UDP ${cfg.udpPorts}; ${cfg.args.length} аргументов`);
      const args = cfg.dnsFix ? await withDnsFilter(cfg.args) : cfg.args;
      const child = await spawnWinws({
        args,
        argsFile: 'winws2.args',
        onLine: (line) => log.write('engine', /error|fail|can't|cannot/i.test(line) ? 'warn' : 'debug', line),
      });
      this.child = child;
      child.once('exit', (code) => this.onExit(code, s));
      this.set({ status: 'running', pid: child.pid ?? null, startedAt: Date.now(), version, argsCount: cfg.args.length });
      log.info('engine', `winws2 запущен (PID ${child.pid})`);
    } catch (e) {
      const msg = (e as Error).message;
      log.error('engine', msg);
      this.set({ status: 'error', pid: null, lastError: msg });
    }
    return this.state;
  }

  private onExit(code: number | null, s: Settings) {
    this.child = null;
    if (this.stopping) {
      this.set({ status: 'stopped', pid: null, startedAt: null });
      return;
    }
    const msg = `winws2 неожиданно завершился (код ${code})`;
    log.error('engine', msg);
    this.set({ status: 'error', pid: null, lastError: msg });
    // Автоперезапуск, но не чаще 3 раз за 2 минуты
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 120_000);
    this.crashes.push(now);
    if (this.crashes.length <= 3) {
      this.restartTimer = setTimeout(() => void this.start(s), 3000);
    }
  }

  async stop(): Promise<EngineState> {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) {
      this.set({ status: 'stopped', pid: null, startedAt: null });
      return this.state;
    }
    this.stopping = true;
    this.set({ status: 'stopping' });
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    if (child.pid) await killTree(child.pid);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 4000))]);
    this.child = null;
    this.set({ status: 'stopped', pid: null, startedAt: null });
    log.info('engine', 'winws2 остановлен');
    return this.state;
  }

  async restart(s: Settings) {
    await this.stop();
    return this.start(s);
  }

  /** Синхронная остановка при выходе из приложения */
  killNow() {
    if (this.child?.pid) {
      this.stopping = true;
      try { process.kill(this.child.pid); } catch { /* ignore */ }
    }
  }
}

export const engine = new Engine();
