'use client';

import { useEffect, useState } from 'react';
import { Gamepad2, Gauge, ListChecks, ScrollText, Send, Settings as SettingsIcon, Sparkles, Stethoscope } from 'lucide-react';
import { statusText, useSnapshot } from '@/lib/api';
import { cx, Dot } from '@/components/ui';
import { Dashboard } from '@/components/views/Dashboard';
import { Strategies } from '@/components/views/Strategies';
import { Telegram } from '@/components/views/Telegram';
import { Warp } from '@/components/views/Warp';
import { Lists } from '@/components/views/Lists';
import { Diagnostics } from '@/components/views/Diagnostics';
import { SettingsView } from '@/components/views/Settings';
import { Logs } from '@/components/views/Logs';
import { DonateCompact } from '@/components/Donate';

export type View = 'dashboard' | 'strategies' | 'telegram' | 'warp' | 'lists' | 'diag' | 'settings' | 'logs';

const NAV: { id: View; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'dashboard', label: 'Обзор', icon: Gauge },
  { id: 'strategies', label: 'Стратегии', icon: Sparkles },
  { id: 'telegram', label: 'Telegram', icon: Send },
  { id: 'warp', label: 'WARP · игры', icon: Gamepad2 },
  { id: 'lists', label: 'Списки', icon: ListChecks },
  { id: 'diag', label: 'Диагностика', icon: Stethoscope },
  { id: 'logs', label: 'Журнал', icon: ScrollText },
  { id: 'settings', label: 'Настройки', icon: SettingsIcon },
];

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  // Начальный раздел из #hash — после гидратации, иначе разметка разойдётся со статическим HTML
  useEffect(() => {
    const h = window.location.hash.slice(1);
    if (NAV.some((n) => n.id === h)) setView(h as View);
  }, []);
  const { snap, error, updateSettings } = useSnapshot();
  const engineTone = !snap ? 'neutral' : snap.engine.status === 'running' ? 'ok' : snap.engine.status === 'error' ? 'bad' : snap.engine.status === 'stopped' ? 'neutral' : 'warn';

  return (
    <div className="flex h-screen flex-col">
      {/* Шапка: перетаскивание окна; справа место под системные кнопки (titleBarOverlay) */}
      <div className="drag flex h-10 shrink-0 items-center gap-2.5 border-b border-line pl-4 pr-[150px]">
        <img src="/icon.png" alt="" className="size-5 rounded" />
        <span className="text-[13px] font-semibold tracking-wide">z2k Windows</span>
        <span className="text-[12px] text-muted">обход блокировок · zapret2</span>
        <span className="ml-auto text-[12px] text-muted">Создано в <span className="font-medium text-fg/80">RuBot.Cloud</span></span>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[212px] shrink-0 flex-col border-r border-line bg-panel/60 p-3">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={cx('mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[14px] transition', view === n.id ? 'bg-panel-2 text-fg' : 'text-muted hover:bg-panel-2/60 hover:text-fg')}
            >
              <n.icon className="size-[18px]" />
              {n.label}
            </button>
          ))}
          <div className="mt-auto mb-3"><DonateCompact /></div>
          <div className="space-y-2 rounded-lg border border-line bg-bg/60 p-3 text-[12.5px]">
            <div className="flex items-center justify-between">
              <span className="text-muted">Обход</span>
              <span className="flex items-center gap-2"><Dot tone={engineTone} />{snap ? statusText(snap.engine.status) : '…'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">WARP</span>
              <span className="flex items-center gap-2"><Dot tone={snap?.warp.ready ? 'ok' : snap?.warp.running ? 'warn' : 'neutral'} />{snap?.warp.ready ? 'туннель' : snap?.warp.running ? 'подъём…' : 'выкл'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Telegram</span>
              <span className="flex items-center gap-2"><Dot tone={snap?.tg.running ? 'ok' : 'neutral'} />{snap?.tg.running ? 'прокси' : 'выкл'}</span>
            </div>
          </div>
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1180px] px-7 py-6">
            {error && <div className="mb-4 rounded-lg border border-bad/30 bg-bad/10 p-3 text-[13px] text-bad">{error}</div>}
            {snap && view === 'dashboard' && <Dashboard snap={snap} go={setView} />}
            {snap && view === 'strategies' && <Strategies snap={snap} />}
            {snap && view === 'telegram' && <Telegram snap={snap} updateSettings={updateSettings} />}
            {snap && view === 'warp' && <Warp snap={snap} updateSettings={updateSettings} />}
            {snap && view === 'lists' && <Lists />}
            {snap && view === 'diag' && <Diagnostics />}
            {snap && view === 'logs' && <Logs />}
            {snap && view === 'settings' && <SettingsView snap={snap} updateSettings={updateSettings} />}
          </div>
        </main>
      </div>
    </div>
  );
}

