'use client';

import { useEffect, useState } from 'react';
import { Play, Power, RotateCcw, Send, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import type { AppInfo, PoolInfo, Snapshot, StateRow } from '@shared/types';
import { api, formatAgo, formatBytes, statusText, useAction, useEvent } from '@/lib/api';
import { Badge, Button, Card, Dot, ErrorNote, PageHeader, Stat } from '@/components/ui';
import type { View } from '@/app/page';
import { DonateCard } from '@/components/Donate';

export function Dashboard({ snap, go }: { snap: Snapshot; go: (v: View) => void }) {
  const { engine, tg, settings } = snap;
  const { busy, error, run } = useAction();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pools, setPools] = useState<PoolInfo[]>([]);
  const [rows, setRows] = useState<StateRow[]>([]);

  useEffect(() => {
    api.invoke<AppInfo>('app:info').then(setInfo).catch(() => undefined);
    api.invoke<PoolInfo[]>('pools:list').then(setPools).catch(() => undefined);
    const load = () => api.invoke<StateRow[]>('state:list').then(setRows).catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  useEvent('settings', () => api.invoke<PoolInfo[]>('pools:list').then(setPools));

  const running = engine.status === 'running';
  const tone = running ? 'ok' : engine.status === 'error' ? 'bad' : engine.status === 'stopped' ? 'neutral' : 'warn';

  return (
    <>
      <PageHeader title="Обзор" description="Пакетный обход DPI на движке zapret2 (winws2 + WinDivert) с профилями и автоподбором стратегий z2k, плюс локальный прокси для Telegram." />

      {info && !info.isAdmin && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-[13.5px] text-warn">
          <TriangleAlert className="size-5 shrink-0" />
          Приложение запущено без прав администратора — WinDivert не сможет перехватывать трафик. Перезапустите от имени администратора.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-start gap-4">
            <div className={`grid size-14 place-items-center rounded-2xl ${running ? 'bg-ok/15 text-ok' : 'bg-panel-2 text-muted'}`}>
              <ShieldCheck className="size-7" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[17px] font-semibold">Обход блокировок <Dot tone={tone} /></div>
              <div className="mt-0.5 text-[13px] text-muted">
                {statusText(engine.status)}
                {running && engine.startedAt ? ` · с ${new Date(engine.startedAt).toLocaleTimeString()}` : ''}
                {engine.pid ? ` · PID ${engine.pid}` : ''}
              </div>
              {engine.lastError && <div className="selectable mt-2 text-[12.5px] text-bad">{engine.lastError}</div>}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            {running ? (
              <Button variant="danger" icon={<Power className="size-4" />} busy={busy === 'stop'} onClick={() => run('stop', () => api.invoke('engine:stop'))}>Выключить</Button>
            ) : (
              <Button variant="primary" icon={<Play className="size-4" />} busy={busy === 'start' || engine.status === 'starting'} onClick={() => run('start', () => api.invoke('engine:start'))}>Включить обход</Button>
            )}
            <Button icon={<RotateCcw className="size-4" />} busy={busy === 'restart'} disabled={!running} onClick={() => run('restart', () => api.invoke('engine:restart'))}>Перезапустить</Button>
          </div>
          <ErrorNote error={error} />
        </Card>

        <Card>
          <div className="flex items-start gap-4">
            <div className={`grid size-14 place-items-center rounded-2xl ${tg.running ? 'bg-accent/15 text-accent' : 'bg-panel-2 text-muted'}`}>
              <Send className="size-7" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[17px] font-semibold">Telegram-прокси <Dot tone={tg.running ? 'ok' : 'neutral'} /></div>
              <div className="mt-0.5 text-[13px] text-muted">
                {tg.running ? `SOCKS5 ${tg.listen} · ${{ ws: 'через WebSocket Telegram', warp: 'через WARP', cfworker: 'через свой Cloudflare Worker', relay: 'через свой VPS-релей', direct: 'прямое подключение' }[tg.mode]}` : 'выключен'}
              </div>
              {tg.running && (
                <div className="mt-0.5 text-[13px] text-muted">
                  {tg.mode === 'warp' ? (snap.warp.ready ? 'WARP подключён: Telegram идёт через туннель у всех программ' : snap.warp.error ? `WARP: ${snap.warp.error}` : 'WARP подключается…') : tg.transparent.running ? 'Прозрачный режим: Telegram без настроек прокси тоже идёт через z2k' : tg.transparent.error ? `Прозрачный режим не работает: ${tg.transparent.error}` : 'Прозрачный режим выключен — только через SOCKS5'}
                </div>
              )}
              {tg.running && (
                <div className="mt-2 text-[12.5px] text-muted">
                  Соединений: <b className="text-fg">{tg.connections}</b> · всего {tg.totalConnections} · ↑ {formatBytes(tg.bytesUp)} ↓ {formatBytes(tg.bytesDown)}
                </div>
              )}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant={tg.running ? 'secondary' : 'primary'} busy={busy === 'tg'} onClick={() => run('tg', () => api.invoke(tg.running ? 'tg:stop' : 'tg:start'))}>
              {tg.running ? 'Выключить' : 'Включить прокси'}
            </Button>
            <Button disabled={!tg.running} onClick={() => api.invoke('tg:connect')}>Подключить Telegram</Button>
            <Button variant="ghost" onClick={() => go('telegram')}>Подробнее</Button>
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Пулов активно" value={`${pools.filter((p) => p.enabled).length} / ${pools.length}`} hint="категории трафика" />
        <Stat label="Стратегий в подборе" value={pools.filter((p) => p.enabled && !p.custom).reduce((a, p) => a + p.strategies, 0)} hint="autocircular z2k" />
        <Stat label="Доменов подобрано" value={rows.length} hint={rows[0] ? `последний ${formatAgo(rows[0].ts * 1000)}` : 'пока нет'} />
        <Stat label="Списки" value={settings.listsUpdatedAt ? formatAgo(settings.listsUpdatedAt) : 'из поставки'} hint="обновление раз в сутки" />
      </div>

      <Card className="mt-4" title="Последние решения автоподбора" subtitle="Какую стратегию движок выбрал для каждого сайта. Ротация идёт сама; закрепить или сменить можно в «Стратегиях»." actions={<Button variant="ghost" icon={<Sparkles className="size-4" />} onClick={() => go('strategies')}>Все стратегии</Button>}>
        {rows.length === 0 ? (
          <p className="text-[13px] text-muted">Записей пока нет — откройте заблокированный сайт при включённом обходе, и движок начнёт подбор.</p>
        ) : (
          <table className="w-full text-[13px]">
            <tbody>
              {rows.slice(0, 8).map((r) => (
                <tr key={`${r.pool}-${r.host}-${r.family}`} className="border-b border-line/60 last:border-0">
                  <td className="py-2 pr-3"><Badge tone="accent">{r.pool}</Badge></td>
                  <td className="py-2 pr-3 font-mono text-[12.5px]">{r.host}</td>
                  <td className="py-2 pr-3">стратегия <b>#{r.strategy}</b>{r.pinned && <span className="ml-2 text-warn">заморожена</span>}</td>
                  <td className="py-2 text-right text-muted">{formatAgo(r.ts * 1000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <DonateCard className="mt-4" />

      {info?.engine && (
        <p className="mt-4 text-[12px] text-muted">
          winws2 {info.engine.winws2} · Lua-ядро {info.engine.luaCore} · профили z2k ({info.engine.z2k}) · данные: <button className="underline decoration-dotted hover:text-fg" onClick={() => api.invoke('app:openData')}>{info.dataDir}</button>
        </p>
      )}
    </>
  );
}
