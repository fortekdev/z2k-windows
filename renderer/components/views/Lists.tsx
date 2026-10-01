'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Save, Search, Trash } from 'lucide-react';
import type { ListInfo } from '@shared/types';
import { api, useAction } from '@/lib/api';
import { Badge, Button, Card, cx, ErrorNote, Input, PageHeader } from '@/components/ui';

export function Lists() {
  const [infos, setInfos] = useState<ListInfo[]>([]);
  const [sel, setSel] = useState('extra');
  const { busy, error, run } = useAction();
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => api.invoke<ListInfo[]>('lists:info').then(setInfos).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);

  const current = infos.find((i) => i.id === sel);

  return (
    <>
      <PageHeader
        title="Списки"
        description="Какие домены обходить и какие не трогать. Базовые списки (РКН, YouTube, Discord) берутся из runetfreedom/russia-blocked-geosite и обновляются раз в сутки; свои списки не перезаписываются."
        actions={
          <Button icon={<RefreshCw className="size-4" />} busy={busy === 'update'} onClick={() => run('update', async () => { const r = await api.invoke<{ summary: string }>('lists:update'); setNote(`Обновлено: ${r.summary}`); await load(); })}>
            Обновить списки
          </Button>
        }
      />
      {note && <div className="mb-4 rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-[13px] text-ok">{note}</div>}
      <ErrorNote error={error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        <div className="space-y-1.5">
          {infos.map((i) => (
            <button key={i.id} onClick={() => setSel(i.id)} className={cx('w-full rounded-lg border px-3.5 py-2.5 text-left transition', sel === i.id ? 'border-accent/50 bg-accent/10' : 'border-line bg-panel hover:border-[#3a4658]')}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13.5px] font-medium">{i.title}</span>
                <Badge tone={i.editable ? 'accent' : 'neutral'}>{i.count.toLocaleString('ru')}</Badge>
              </div>
            </button>
          ))}
        </div>
        {current && (current.editable ? <EditableList key={current.id} info={current} onSaved={load} /> : <ReadonlyList key={current.id} info={current} />)}
      </div>
    </>
  );
}

function EditableList({ info, onSaved }: { info: ListInfo; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [orig, setOrig] = useState('');
  const [add, setAdd] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    api.invoke<{ entries: string[] }>('lists:read', info.id).then((r) => { setText(r.entries.join('\n')); setOrig(r.entries.join('\n')); }).catch(() => undefined);
  }, [info.id]);

  const isIp = info.id === 'exclude-ips';

  const addOne = async () => {
    const v = add.trim();
    if (!v) return;
    if (!isIp) {
      const where = await api.invoke<string[]>('lists:where', v);
      if (where.length) {
        setHint(`«${v}» уже покрыт списком: ${where.join(', ')}`);
        return;
      }
    }
    setText((t) => (t.trim() ? `${t.trim()}\n${v}` : v));
    setAdd('');
    setHint(null);
  };

  const save = () => run('save', async () => {
    const r = await api.invoke<{ saved: number; rejected: string[] }>('lists:write', info.id, text.split(/\r?\n/));
    setHint(r.rejected.length ? `Не приняты (неверный формат): ${r.rejected.join(', ')}` : `Сохранено: ${r.saved}. Обход перезапущен.`);
    const fresh = await api.invoke<{ entries: string[] }>('lists:read', info.id);
    setText(fresh.entries.join('\n'));
    setOrig(fresh.entries.join('\n'));
    onSaved();
  });

  return (
    <Card title={info.title} subtitle={info.description} actions={<Button variant="primary" icon={<Save className="size-4" />} busy={busy === 'save'} disabled={text === orig} onClick={save}>Сохранить</Button>}>
      <div className="mb-3 flex gap-2">
        <Input value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addOne()} placeholder={isIp ? '203.0.113.7 или 203.0.113.0/24' : 'example.com'} className="flex-1 font-mono" />
        <Button icon={<Plus className="size-4" />} onClick={() => void addOne()}>Добавить</Button>
      </div>
      {hint && <p className="mb-3 text-[13px] text-warn">{hint}</p>}
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className="selectable h-[420px] w-full resize-y rounded-lg border border-line bg-bg p-3 font-mono text-[12.5px] leading-relaxed outline-none focus:border-accent" placeholder="по одной записи на строку" />
      <p className="mt-2 text-[12px] text-muted">{isIp ? 'Локальные сети (192.168.x, 10.x, 172.16–31.x) исключены всегда.' : 'Без http:// и www. Поддомены покрываются автоматически.'}</p>
      <ErrorNote error={error} />
    </Card>
  );
}

function ReadonlyList({ info }: { info: ListInfo }) {
  const [entries, setEntries] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  useEffect(() => {
    api.invoke<{ entries: string[]; total: number }>('lists:read', info.id).then((r) => { setEntries(r.entries); setTotal(r.total); }).catch(() => undefined);
  }, [info.id]);
  const shown = q ? entries.filter((e) => e.includes(q.toLowerCase())) : entries;
  return (
    <Card title={info.title} subtitle={`${info.description} · ${total.toLocaleString('ru')} записей`} actions={
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="поиск в первых 5000" className="w-56 pl-8" />
      </div>
    }>
      <div className="selectable h-[480px] overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[12.5px] leading-relaxed">
        {shown.slice(0, 2000).map((e) => <div key={e}>{e}</div>)}
        {shown.length > 2000 && <div className="mt-2 text-muted">… и ещё {shown.length - 2000}</div>}
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[12px] text-muted"><Trash className="size-3.5" />Базовые списки не редактируются: чтобы не трогать домен, добавьте его в «Исключения: домены».</p>
    </Card>
  );
}
