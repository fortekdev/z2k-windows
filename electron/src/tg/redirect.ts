// Прозрачный перехват Telegram — Windows-аналог z2k-tg-redirect.sh (iptables REDIRECT подсетей Telegram на :1443).
// z2k-tgredir.exe через WinDivert «отражает» соединения любых программ к подсетям Telegram на свой порт и передаёт их
// в наш SOCKS5-прокси с исходным адресом: Telegram Desktop без настроек прокси и веб-версия в браузере идут тем же
// путём, что и через прокси (WebSocket / свой Cloudflare Worker / напрямую). Собственные соединения z2k не трогаются.
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { TgRedirectState } from '../../../shared/types';
import { res } from '../paths';
import { log } from '../logger';
import { killTree } from '../engine/winws';

export interface RedirectOptions {
  socksPort: number;
  auth: { user: string; pass: string } | null;
  nets: string[]; // CIDR
}

class TgRedirect extends EventEmitter {
  private child: ChildProcess | null = null;
  private want: RedirectOptions | null = null;
  private crashes: number[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  state: TgRedirectState = { running: false, active: 0, error: null };

  private set(patch: Partial<TgRedirectState>) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async start(opts: RedirectOptions): Promise<void> {
    await this.stop();
    this.want = opts;
    this.crashes = [];
    await this.spawn(opts).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.want = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const child = this.child;
    this.child = null;
    if (child?.pid && child.exitCode === null) {
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      await killTree(child.pid);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      log.info('tg', 'Прозрачный перехват Telegram выключен');
    }
    this.set({ running: false, active: 0, error: null });
  }

  /** Синхронно при выходе из приложения (хелпер и сам завершается вместе с z2k) */
  killNow() {
    this.want = null;
    this.child?.kill();
    this.child = null;
  }

  private spawn(opts: RedirectOptions): Promise<void> {
    const exe = res.tgredir();
    if (!existsSync(exe)) {
      const msg = `Не найден ${exe}. Выполните npm run build:tgredir`;
      log.error('tg', msg);
      this.set({ running: false, error: msg });
      return Promise.reject(new Error(msg));
    }
    const args = [
      `--socks=127.0.0.1:${opts.socksPort}`,
      `--nets=${opts.nets.join(',')}`,
      `--exclude-pid=${process.pid}`, // прокси работает в главном процессе и сам ходит к IP Telegram
      `--parent-pid=${process.pid}`,
    ];
    const env = { ...process.env, Z2K_SOCKS_USER: opts.auth?.user ?? '', Z2K_SOCKS_PASS: opts.auth?.pass ?? '' };
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { cwd: res.bin(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let ready = false;
      let lastError = '';
      const onLine = (line: string) => {
        const sp = line.indexOf(' ');
        const level = sp < 0 ? line : line.slice(0, sp);
        const msg = sp < 0 ? '' : line.slice(sp + 1);
        switch (level) {
          case 'READY':
            ready = true;
            this.set({ running: true, active: 0, error: null });
            log.info('tg', `Прозрачный перехват Telegram включён (WinDivert, ${msg}): программы без настроек прокси идут через z2k`);
            resolve();
            break;
          case 'STAT':
            this.set({ active: Number(/active=(\d+)/.exec(msg)?.[1] ?? 0) });
            break;
          case 'ERROR':
            lastError = msg;
            log.error('tg', `Перехват: ${msg}`);
            break;
          case 'WARN':
            log.warn('tg', `Перехват: ${msg}`);
            break;
          case 'INFO':
            log.info('tg', `Перехват: ${msg}`);
            break;
          default:
            log.debug('tg', `Перехват: ${level === 'DEBUG' ? msg : line}`);
        }
      };
      createInterface({ input: child.stdout! }).on('line', onLine);
      createInterface({ input: child.stderr! }).on('line', onLine);
      child.on('error', (e) => { lastError = e.message; });
      child.on('exit', (code) => {
        if (this.child === child) this.child = null;
        const err = lastError || `z2k-tgredir завершился с кодом ${code}`;
        if (!ready) {
          this.set({ running: false, active: 0, error: err });
          reject(new Error(err));
          return;
        }
        if (this.want !== opts) return; // штатная остановка или перезапуск с новыми параметрами
        this.set({ running: false, active: 0, error: err });
        this.restartLater(opts, err);
      });
    });
  }

  /** Неожиданное падение: до 3 перезапусков за 2 минуты, как у winws2 */
  private restartLater(opts: RedirectOptions, err: string) {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 120_000);
    this.crashes.push(now);
    if (this.crashes.length > 3) {
      log.error('tg', `Перехват Telegram падает раз за разом (${err}) — перезапуски остановлены`);
      return;
    }
    log.warn('tg', `Перехват Telegram упал (${err}) — перезапуск через 3 с`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.want === opts) void this.spawn(opts).catch(() => undefined);
    }, 3000);
  }
}

export const tgRedirect = new TgRedirect();
