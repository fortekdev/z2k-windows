'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleCheck, CircleX, Lock, LockOpen, Play, RotateCcw, Save, Search, Square, WandSparkles, X } from 'lucide-react';
import type { AutopickJob, PoolId, PoolInfo, Snapshot, StateRow } from '@shared/types';
import { api, formatAgo, useAction, useAutopick } from '@/lib/api';
import { Badge, Button, Card, cx, ErrorNote, Input, PageHeader, Select, Tabs, Toggle } from '@/components/ui';

type Tab = 'state' | 'pick' | 'custom';

export function Strategies({ snap }: { snap: Snapshot }) {
  const [tab, setTab] = useState<Tab>('state');
  const [pools, setPools] = useState<PoolInfo[]>([]);
  const loadPools = useCallback(() => api.invoke<PoolInfo[]>('pools:list').then(setPools).catch(() => undefined), []);
  useEffect(() => { void loadPools(); }, [loadPools]);

  return (
    <>
      <PageHeader
        title="Стратегии"
        description="Каждый пул (категория трафика) содержит набор стратегий z2k. Модуль circular перебирает их по каждому сайту и запоминает рабочую; здесь можно посмотреть выбор, закрепить его, подобрать заново или задать свою строку."
        actions={<Tabs value={tab} onChange={setTab} tabs={[{ id: 'state', label: 'Автоподбор' }, { id: 'pick', label: 'Подобрать' }, { id: 'custom', label: 'Свои стратегии' }]} />}
      />
      {tab === 'state' && <StateTab pools={pools} />}
      {tab === 'pick' && <PickTab pools={pools} running={snap.engine.status === 'running'} />}
      {tab === 'custom' && <CustomTab pools={pools} reload={loadPools} />}
    </>
  );
}

// ---------------- Автоподбор: что выбрано ----------------

function StateTab({ pools }: { pools: PoolInfo[] }) {
  const [rows, setRows] = useState<StateRow[]>([]);
  const [filter, setFilter] = useState('');
  const [pool, setPool] = useState('all');
  const { error, run } = useAction();

  const load = useCallback(() => api.invoke<StateRow[]>('state:list').then(setRows).catch(() => undefined), []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const counts = useMemo(() => Object.fromEntries(pools.map((p) => [p.id, p.strategies])), [pools]);
  const shown = rows.filter((r) => (pool === 'all' || r.pool === pool) && (!filter || r.host.includes(filter.toLowerCase())));

  const act = (fn: () => Promise<unknown>) => run('row', async () => { await fn(); await load(); });

  return (
    <Card
      title={`Выбор автоподбора · ${rows.length}`}
      subtitle="Изменения подхватываются движком на лету (~2 с). Замок — заморозить строку на текущей стратегии; × — сбросить на стратегию 1."
      actions={
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
            <Input placeholder="домен" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48 pl-8" />
          </div>
          <Select value={pool} onChange={setPool} options={[{ value: 'all', label: 'Все пулы' }, ...pools.map((p) => ({ value: p.id, label: p.title }))]} />
          <Button variant="danger" onClick={() => confirm('Сбросить выбор для всех доменов? Подбор начнётся заново.') && act(() => api.invoke('state:reset', pool === 'all' ? null : pool))}>Сбросить</Button>
        </>
      }
    >
      {shown.length === 0 ? (
        <p className="text-[13px] text-muted">Нет записей. Они появляются, когда через обход открываются сайты из списков.</p>
      ) : (
        <div className="-mx-5 -my-5 max-h-[calc(100vh-290px)] overflow-y-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-panel text-left text-[12px] uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-2.5 font-medium">Пул</th>
                <th className="py-2.5 font-medium">Домен</th>
                <th className="py-2.5 font-medium">Стратегия</th>
                <th className="py-2.5 font-medium">Изменено</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const n = counts[r.pool] ?? Math.max(r.strategy, 1);
                return (
                  <tr key={`${r.pool}|${r.host}|${r.family}`} className="border-b border-line/50 hover:bg-panel-2/40">
                    <td className="px-5 py-2"><Badge tone="accent">{r.pool}</Badge></td>
                    <td className="selectable py-2 font-mono text-[12.5px]">{r.host}{r.family && <span className="ml-1 text-muted">IPv{r.family}</span>}</td>
                    <td className="py-2">
                      <Select
                        value={String(r.strategy)}
                        onChange={(v) => act(() => api.invoke('state:set', r.pool, r.host, r.family, Number(v)))}
                        options={Array.from({ length: n }, (_, i) => ({ value: String(i + 1), label: `#${i + 1}` }))}
                        className="h-8 w-24"
                      />
                    </td>
                    <td className="py-2 text-muted">{formatAgo(r.ts * 1000)}</td>
                    <td className="px-5 py-2 text-right">
                      <button title={r.pinned ? 'Разморозить' : 'Заморозить'} onClick={() => act(() => api.invoke('state:freeze', r.pool, r.host, r.family, !r.pinned))} className={cx('mr-1 rounded-md p-1.5 hover:bg-panel-2', r.pinned ? 'text-warn' : 'text-muted')}>
                        {r.pinned ? <Lock className="size-4" /> : <LockOpen className="size-4" />}
                      </button>
                      <button title="Сбросить" onClick={() => act(() => api.invoke('state:delete', r.pool, r.host, r.family))} className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-bad">
                        <X className="size-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ErrorNote error={error} />
    </Card>
  );
}

// ---------------- Подбор через движок ----------------

function PickTab({ pools, running }: { pools: PoolInfo[]; running: boolean }) {
  const job = useAutopick();
  const [targets, setTargets] = useState<{ pool: PoolId; target: string }[]>([]);
  const [pool, setPool] = useState<PoolId>('rkn_tcp');
  const [host, setHost] = useState('rutracker.org');
  const [apply, setApply] = useState(true);
  const [freeze, setFreeze] = useState(false);
  const [stopOnFirst, setStopOnFirst] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => {
    api.invoke<{ pool: PoolId; target: string }[]>('autopick:pools').then(setTargets).catch(() => undefined);
  }, []);

  const active = job?.status === 'running';
  const pct = job && job.total ? Math.round((job.tested / job.total) * 100) : 0;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
      <Card title="Подбор стратегии" subtitle="Каждая стратегия пула запускается в движке отдельно и проверяется настоящим запросом к сайту. Основной обход на время подбора приостанавливается.">
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-[12.5px] text-muted">Пул</div>
            <Select
              value={pool}
              onChange={(v) => {
                setPool(v as PoolId);
                const t = targets.find((x) => x.pool === v);
                if (t) setHost(t.target);
              }}
              options={targets.map((t) => ({ value: t.pool, label: `${pools.find((p) => p.id === t.pool)?.title ?? t.pool} · ${pools.find((p) => p.id === t.pool)?.strategies ?? '?'} стратегий` }))}
              className="w-full"
            />
          </div>
          <div>
            <div className="mb-1.5 text-[12.5px] text-muted">Проверочный домен</div>
            <Input value={host} onChange={(e) => setHost(e.target.value)} className="w-full font-mono" placeholder="example.com" />
          </div>
          <Toggle checked={apply} onChange={setApply} label="Закрепить лучшую" hint="Записать первую рабочую стратегию в память автоподбора для этого домена" />
          <Toggle checked={freeze} onChange={setFreeze} disabled={!apply} label="Заморозить" hint="Ротация не будет менять закреплённую стратегию" />
          <Toggle checked={stopOnFirst} onChange={setStopOnFirst} label="Остановиться на первой рабочей" hint="Быстрее, но без полной картины по пулу" />
          {!running && <p className="text-[12.5px] text-muted">Основной обход сейчас выключен — после подбора он останется выключенным.</p>}
          <div className="flex gap-2">
            {active ? (
              <Button variant="danger" icon={<Square className="size-4" />} onClick={() => api.invoke('autopick:cancel')}>Остановить</Button>
            ) : (
              <Button variant="primary" icon={<WandSparkles className="size-4" />} busy={busy === 'run'} disabled={!host.trim()} onClick={() => run('run', () => api.invoke('autopick:run', { pool, host, apply, freeze, stopOnFirst, repeats: 2 }))}>
                Подобрать
              </Button>
            )}
          </div>
          <ErrorNote error={error} />
        </div>
      </Card>

      <Card title={job ? `${job.pool} · ${job.host}` : 'Результаты'} subtitle={job ? jobSubtitle(job) : 'Запустите подбор, чтобы увидеть, какие стратегии работают на вашей линии.'}>
        {job ? (
          <>
            <div className="mb-4 h-2 overflow-hidden rounded-full bg-bg">
              <div className={cx('h-full transition-all', job.status === 'failed' ? 'bg-bad' : 'bg-accent')} style={{ width: `${job.status === 'running' ? pct : 100}%` }} />
            </div>
            {job.baseline && (
              <div className="mb-4 rounded-lg border border-line bg-bg/50 px-3 py-2 text-[13px]">
                Без обхода: <b className={job.baseline.verdict === 'ok' ? 'text-ok' : 'text-warn'}>{job.baseline.verdictText}</b>
                <span className="text-muted"> · {job.baseline.ips.slice(0, 3).join(', ')}</span>
              </div>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-1.5">
              {Array.from({ length: job.total }, (_, i) => {
                const n = i + 1;
                const r = job.results.find((x) => x.strategy === n);
                const cur = job.current === n;
                return (
                  <div
                    key={n}
                    title={r ? `#${n}: ${r.ok ? 'работает' : 'нет'} — ${r.detail} (${(r.ms / 1000).toFixed(1)} с)` : `#${n}`}
                    className={cx(
                      'grid h-10 place-items-center rounded-md border text-[12.5px] font-medium tabular-nums',
                      cur && 'animate-pulse border-accent text-accent',
                      !cur && !r && 'border-line text-muted',
                      r?.ok && 'border-ok/40 bg-ok/15 text-ok',
                      r && !r.ok && 'border-line bg-bad/5 text-bad/70',
                      job.applied === n && 'ring-2 ring-ok',
                    )}
                  >
                    {n}
                  </div>
                );
              })}
            </div>
            {job.found.length > 0 && (
              <p className="mt-4 text-[13px]">
                <CircleCheck className="mr-1.5 inline size-4 text-ok" />
                Рабочие: <b>{job.found.map((n) => `#${n}`).join(', ')}</b>
                {job.applied && <> · закреплена <b>#{job.applied}</b></>}
              </p>
            )}
            {job.status === 'done' && job.found.length === 0 && (
              <p className="mt-4 text-[13px] text-warn"><CircleX className="mr-1.5 inline size-4" />Ни одна стратегия пула не прошла проверку. Возможно, сайт заблокирован по IP — тут поможет только туннель.</p>
            )}
            {job.error && <ErrorNote error={job.error} />}
          </>
        ) : (
          <p className="text-[13px] text-muted">Подбор займёт 1–3 минуты в зависимости от размера пула.</p>
        )}
      </Card>
    </div>
  );
}

function jobSubtitle(j: AutopickJob) {
  const st = { running: 'идёт подбор', done: 'завершён', failed: 'ошибка', cancelled: 'остановлен' }[j.status];
  const dur = ((j.finishedAt ?? Date.now()) - j.startedAt) / 1000;
  return `${st} · проверено ${j.tested} из ${j.total} · ${Math.round(dur)} с`;
}

// ---------------- Свои стратегии ----------------

function CustomTab({ pools, reload }: { pools: PoolInfo[]; reload: () => void }) {
  const [pool, setPool] = useState<PoolId>('rkn_tcp');
  const [text, setText] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; output: string } | null>(null);
  const [preview, setPreview] = useState<{ n: number; lines: string[]; circular: string | null }>({ n: 1, lines: [], circular: null });
  const { busy, error, run } = useAction();
  const info = pools.find((p) => p.id === pool);

  useEffect(() => {
    setCheck(null);
    api.invoke<string>('custom:get', pool).then(setText).catch(() => setText(''));
    api.invoke<string | null>('pools:circular', pool).then((circular) => setPreview((p) => ({ ...p, circular }))).catch(() => undefined);
  }, [pool]);

  useEffect(() => {
    api.invoke<string[]>('pools:strategy', pool, preview.n).then((lines) => setPreview((p) => ({ ...p, lines }))).catch(() => undefined);
  }, [pool, preview.n]);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr]">
      <Card
        title="Своя строка для пула"
        subtitle="Заменяет набор стратегий пула целиком и выключает для него автоподбор (если в строке нет circular). Фильтры и списки пула сохраняются. Перед сохранением строка проверяется движком в составе полной конфигурации."
      >
        <div className="mb-3 flex items-center gap-2">
          <Select value={pool} onChange={(v) => setPool(v as PoolId)} options={pools.map((p) => ({ value: p.id, label: `${p.title}${p.custom ? ' · своя' : ''}` }))} className="flex-1" />
          {info?.custom && <Badge tone="warn">автоподбор выключен</Badge>}
        </div>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setCheck(null); }}
          spellCheck={false}
          placeholder={'# параметры winws2, можно в несколько строк\n--lua-desync=multisplit:payload=tls_client_hello:dir=out:pos=1,midsld'}
          className="selectable h-64 w-full resize-y rounded-lg border border-line bg-bg p-3 font-mono text-[12.5px] leading-relaxed outline-none focus:border-accent"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button icon={<Play className="size-4" />} busy={busy === 'check'} onClick={() => run('check', async () => setCheck(await api.invoke('custom:validate', pool, text)))}>Проверить</Button>
          <Button variant="primary" icon={<Save className="size-4" />} busy={busy === 'save'} onClick={() => run('save', async () => { const r = await api.invoke<{ ok: boolean; output: string }>('custom:save', pool, text); setCheck(r); reload(); })}>Сохранить и применить</Button>
          {info?.custom && <Button icon={<RotateCcw className="size-4" />} busy={busy === 'del'} onClick={() => run('del', async () => { await api.invoke('custom:delete', pool); setText(''); reload(); })}>Вернуть автоподбор</Button>}
        </div>
        {check && (
          <pre className={cx('selectable mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border p-3 font-mono text-[12px]', check.ok ? 'border-ok/30 bg-ok/5 text-ok' : 'border-bad/30 bg-bad/5 text-bad')}>
            {check.ok ? 'Движок принял конфигурацию.' : check.output.split('\n').slice(-12).join('\n')}
          </pre>
        )}
        <ErrorNote error={error} />
      </Card>

      <Card title="Штатные стратегии пула" subtitle="За основу своей строки удобно взять одну из штатных стратегий z2k.">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[13px] text-muted">Стратегия</span>
          <Select value={String(preview.n)} onChange={(v) => setPreview((p) => ({ ...p, n: Number(v) }))} options={Array.from({ length: info?.strategies ?? 0 }, (_, i) => ({ value: String(i + 1), label: `#${i + 1}` }))} className="w-24" />
          <Button variant="ghost" onClick={() => { setText(preview.lines.join('\n')); setCheck(null); }}>Взять за основу</Button>
        </div>
        <pre className="selectable max-h-[340px] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-bg p-3 font-mono text-[12px] leading-relaxed">{preview.lines.join('\n') || '—'}</pre>
        {preview.circular && (
          <>
            <div className="mb-1.5 mt-4 text-[12.5px] text-muted">Ротация пула (circular)</div>
            <pre className="selectable overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-bg p-3 font-mono text-[12px]">{preview.circular}</pre>
          </>
        )}
      </Card>
    </div>
  );
}
