'use client';

import { useEffect, useState } from 'react';
import { CircleCheck, CircleQuestionMark, CircleX, Copy, Search, Wrench } from 'lucide-react';
import type { ProbeResult, SystemCheck } from '@shared/types';
import { api, useAction } from '@/lib/api';
import { Badge, Button, Card, cx, ErrorNote, Input, PageHeader } from '@/components/ui';

const STAGE: Record<string, string> = { dns: 'DNS', tcp: 'TCP', tls: 'TLS', http: 'HTTP' };
const FIX_LABEL: Record<string, string> = { 'tcp-timestamps': 'Включить', 'kill-foreign': 'Завершить', 'dnsfix-refresh': 'Обновить адреса' };

export function Diagnostics() {
  const [checks, setChecks] = useState<SystemCheck[] | null>(null);
  const [host, setHost] = useState('');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => { void run('checks', async () => setChecks(await api.invoke<SystemCheck[]>('diag:checks'))); }, [run]);

  return (
    <>
      <PageHeader
        title="Диагностика"
        description="Проверка домена по стадиям и состояние системы. Проба идёт обычным соединением этого компьютера — при включённом обходе она показывает результат с обходом."
        actions={<Button icon={<Copy className="size-4" />} busy={busy === 'report'} onClick={() => run('report', async () => { await navigator.clipboard.writeText(await api.invoke<string>('diag:report')); setCopied(true); setTimeout(() => setCopied(false), 2000); })}>{copied ? 'Сводка скопирована' : 'Копировать сводку'}</Button>}
      />

      <Card title="Проверка домена" subtitle="DNS → TCP → TLS → HTTP: на какой стадии обрывается соединение и есть ли домен в списках обхода.">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (host.trim()) void run('probe', async () => setProbe(await api.invoke<ProbeResult>('probe:run', host))); }}>
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="rutracker.org" className="flex-1 font-mono" />
          <Button variant="primary" icon={<Search className="size-4" />} busy={busy === 'probe'} type="submit">Проверить</Button>
        </form>
        {probe && (
          <div className="mt-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className={cx('text-[16px] font-semibold', probe.verdict === 'ok' ? 'text-ok' : 'text-warn')}>{probe.verdictText}</span>
              {probe.inLists.length ? probe.inLists.map((l) => <Badge key={l} tone="accent">{l}</Badge>) : <Badge>нет в списках обхода</Badge>}
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2">
              {(['dns', 'tcp', 'tls', 'http'] as const).map((st) => {
                const s = probe.stages.find((x) => x.stage === st);
                return (
                  <div key={st} className={cx('rounded-lg border p-3', !s ? 'border-line opacity-40' : s.ok ? 'border-ok/30 bg-ok/5' : 'border-bad/30 bg-bad/5')}>
                    <div className="flex items-center justify-between text-[13px] font-semibold">
                      {STAGE[st]}
                      {s && <span className="text-[12px] font-normal text-muted">{s.ms} мс</span>}
                    </div>
                    <div className="selectable mt-1 break-words text-[12px] text-muted">{s?.detail ?? 'не дошли'}</div>
                  </div>
                );
              })}
            </div>
            {probe.verdict === 'tcp_blocked' ? (
              <p className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn">
                Соединение не устанавливается совсем — это блокировка по IP. Стратегии обхода здесь не помогут, и автоподбор их не переключает:
                до отправки ClientHello дело не доходит. Для Instagram, WhatsApp и Facebook движок сам подменяет такой адрес на рабочий в ответах DNS (строка ниже); для остального — WARP.
              </p>
            ) : probe.verdict !== 'ok' && probe.inLists.length === 0 && probe.verdict !== 'dns_blocked' && (
              <p className="mt-3 text-[13px] text-muted">Домена нет в списках — добавьте его в «Списки → Свои домены», и автоподбор начнёт работать для него.</p>
            )}
          </div>
        )}
      </Card>

      <Card className="mt-4" title="Система" actions={<Button variant="ghost" busy={busy === 'checks'} onClick={() => run('checks', async () => setChecks(await api.invoke<SystemCheck[]>('diag:checks')))}>Обновить</Button>}>
        {!checks ? (
          <p className="text-[13px] text-muted">Проверяю…</p>
        ) : (
          <div className="divide-y divide-line/60">
            {checks.map((c) => (
              <div key={c.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                {c.ok === true ? <CircleCheck className="size-5 shrink-0 text-ok" /> : c.ok === false ? <CircleX className="size-5 shrink-0 text-bad" /> : <CircleQuestionMark className="size-5 shrink-0 text-warn" />}
                <div className="min-w-0 flex-1">
                  <div className="text-[14px]">{c.title}</div>
                  <div className="selectable text-[12.5px] text-muted">{c.detail}</div>
                </div>
                {c.fix && (
                  <Button icon={<Wrench className="size-4" />} busy={busy === c.fix} onClick={() => run(c.fix!, async () => setChecks(await api.invoke<SystemCheck[]>('diag:fix', c.fix)))}>
                    {FIX_LABEL[c.fix] ?? 'Исправить'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        <ErrorNote error={error} />
      </Card>
    </>
  );
}
