// Автоподбор стратегии: каждая стратегия пула по очереди исполняется настоящим winws2
// (без circular, только для проверяемого домена), а успех определяется реальной HTTPS-пробой.
// Детектор z2k (classify) собирает пакеты сырыми сокетами Linux — под Windows так нельзя,
// а прогон через движок к тому же проверяет ровно ту строку, что пойдёт в работу.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { AutopickJob, PoolId, Settings } from '../../../shared/types';
import { log } from '../logger';
import { res } from '../paths';
import { globalArgs } from '../engine/config';
import { loadProfiles, singleStrategyProfile, strategyNumbers } from '../engine/profiles';
import { engine, killTree, spawnWinws } from '../engine/winws';
import { setStrategy } from '../engine/state';
import { probe } from './probe';

export const AUTOPICK_POOLS: PoolId[] = ['rkn_tcp', 'yt_tcp', 'gv_tcp', 'http_rkn'];

export const DEFAULT_TARGETS: Record<string, string> = {
  rkn_tcp: 'rutracker.org',
  yt_tcp: 'www.youtube.com',
  gv_tcp: 'redirector.googlevideo.com',
  http_rkn: 'rutracker.org',
};

/** Ключ хоста как у z2k (standard_hostkey, nld=2): второй уровень домена */
export function hostKey(host: string): string {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  return parts.slice(-2).join('.');
}

export interface AutopickRequest {
  pool: PoolId;
  host: string;
  apply: boolean; // записать лучшую стратегию в state.tsv
  freeze: boolean;
  stopOnFirst: boolean;
  repeats: number;
}

class Autopick extends EventEmitter {
  private job: AutopickJob | null = null;
  private cancelled = false;
  private child: ChildProcess | null = null;

  current() {
    return this.job;
  }

  private update(patch: Partial<AutopickJob>) {
    if (!this.job) return;
    this.job = { ...this.job, ...patch };
    this.emit('job', this.job);
  }

  cancel() {
    this.cancelled = true;
    if (this.child?.pid) void killTree(this.child.pid);
  }

  async run(req: AutopickRequest, s: Settings): Promise<AutopickJob> {
    if (this.job?.status === 'running') throw new Error('Подбор уже идёт');
    if (!AUTOPICK_POOLS.includes(req.pool)) throw new Error('Для этого пула автоподбор по пробе недоступен');
    const host = req.host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const profiles = loadProfiles(res.profiles());
    const numbers = strategyNumbers(profiles, req.pool);
    this.cancelled = false;
    this.job = {
      id: randomUUID(), pool: req.pool, host, status: 'running', tested: 0, total: numbers.length, current: null,
      found: [], results: [], baseline: null, startedAt: Date.now(), finishedAt: null, applied: null, error: null,
    };
    this.emit('job', this.job);

    const wasRunning = engine.isRunning();
    const http = req.pool === 'http_rkn';
    try {
      // Основной движок держит тот же трафик в WinDivert — на время подбора останавливаем
      if (wasRunning) {
        log.info('autopick', 'Основной обход приостановлен на время подбора');
        await engine.stop();
      }
      const baseline = await probe(host, { http, dohCompare: true });
      this.update({ baseline });
      log.info('autopick', `${host}: без обхода — ${baseline.verdictText}`);
      if (baseline.verdict === 'dns_blocked') throw new Error('Имя не резолвится — подбор стратегии не поможет (нужен другой DNS)');
      const ip = baseline.ips[0];

      const ports = http ? '80' : '443';
      for (const n of numbers) {
        if (this.cancelled) break;
        this.update({ current: n });
        const prof = singleStrategyProfile(profiles, req.pool, n, [`--hostlist-domains=${host}`]);
        if (!prof) { this.update({ tested: this.job!.tested + 1 }); continue; }
        // Подменяем порты фильтра на проверяемый
        const profile = prof.map((t) => (t.startsWith('--filter-tcp=') ? `--filter-tcp=${ports}` : t));
        const args = [...globalArgs(s, { tcpPorts: ports, udpPorts: '', inbound: true }), '--wf-dup-check=0', ...profile];
        let ok = false;
        let detail = '';
        const t0 = Date.now();
        try {
          this.child = await spawnWinws({ args, argsFile: 'winws2.autopick.args' });
          let passes = 0;
          for (let i = 0; i < req.repeats; i++) {
            const r = await probe(host, { ip, http, timeoutMs: 6000 });
            detail = r.verdict === 'ok' ? `${r.bytes} байт` : r.verdictText;
            if (r.verdict === 'ok') passes++;
            else break;
          }
          ok = passes === req.repeats;
        } catch (e) {
          detail = (e as Error).message;
        } finally {
          if (this.child?.pid) await killTree(this.child.pid);
          this.child = null;
        }
        const results = [...this.job!.results, { strategy: n, ok, ms: Date.now() - t0, detail }];
        const found = ok ? [...this.job!.found, n] : this.job!.found;
        this.update({ tested: this.job!.tested + 1, results, found });
        log.info('autopick', `${req.pool} #${n}: ${ok ? 'работает' : 'нет'} (${detail})`);
        if (ok && req.stopOnFirst) break;
      }

      const best = this.job!.found[0] ?? null;
      if (this.cancelled) {
        this.update({ status: 'cancelled', finishedAt: Date.now(), current: null });
      } else {
        if (best !== null && req.apply) {
          await setStrategy(req.pool, hostKey(host), '4', best, req.freeze);
          this.update({ applied: best });
          log.info('autopick', `${hostKey(host)}: закреплена стратегия ${best} в пуле ${req.pool}${req.freeze ? ' (заморожена)' : ''}`);
        }
        this.update({ status: 'done', finishedAt: Date.now(), current: null });
      }
    } catch (e) {
      const msg = (e as Error).message;
      log.error('autopick', msg);
      this.update({ status: 'failed', error: msg, finishedAt: Date.now(), current: null });
    } finally {
      if (wasRunning) {
        await engine.start(s);
        log.info('autopick', 'Основной обход возобновлён');
      }
    }
    return this.job!;
  }
}

export const autopick = new Autopick();
