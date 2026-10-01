'use client';

import { useEffect, useRef, useState } from 'react';
import { useLogs } from '@/lib/api';
import { cx, PageHeader, Tabs, Toggle } from '@/components/ui';

type Src = 'all' | 'app' | 'engine' | 'tg' | 'autopick' | 'lists' | 'diag';

const LEVEL = { debug: 'text-muted/70', info: 'text-fg', warn: 'text-warn', error: 'text-bad' };

export function Logs() {
  const [src, setSrc] = useState<Src>('all');
  const [debug, setDebug] = useState(false);
  const logs = useLogs(src === 'all' ? undefined : src);
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  const shown = debug ? logs : logs.filter((l) => l.level !== 'debug');

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, follow]);

  return (
    <>
      <PageHeader
        title="Журнал"
        actions={
          <Tabs value={src} onChange={setSrc} tabs={[
            { id: 'all', label: 'Все' }, { id: 'engine', label: 'Движок' }, { id: 'tg', label: 'Telegram' }, { id: 'autopick', label: 'Подбор' }, { id: 'lists', label: 'Списки' }, { id: 'app', label: 'Приложение' },
          ]} />
        }
      />
      <div className="mb-3 flex gap-6">
        <Toggle checked={debug} onChange={setDebug} label="Отладочные строки" />
        <Toggle checked={follow} onChange={setFollow} label="Прокручивать к новым" />
      </div>
      <div ref={box} className="selectable h-[calc(100vh-230px)] overflow-y-auto rounded-xl border border-line bg-[#0a0e14] p-3 font-mono text-[12px] leading-[1.55]">
        {shown.length === 0 && <div className="text-muted">Пусто</div>}
        {shown.map((l) => (
          <div key={l.id} className={cx('whitespace-pre-wrap break-all', LEVEL[l.level])}>
            <span className="text-muted/60">{new Date(l.ts).toLocaleTimeString()} </span>
            <span className="text-accent/80">[{l.source}]</span> {l.msg}
          </div>
        ))}
      </div>
    </>
  );
}
