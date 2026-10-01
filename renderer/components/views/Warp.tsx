'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cloud, KeyRound, Power, RefreshCw, Save, Search, Sparkles, TriangleAlert } from 'lucide-react';
import type { Snapshot, WarpAccount, WarpSettings } from '@shared/types';
import { api, formatAgo, formatBytes, useAction } from '@/lib/api';
import { Badge, Button, Card, cx, Dot, ErrorNote, Input, PageHeader, Select, Stat, Toggle } from '@/components/ui';

interface GameInfo { id: string; title: string; ips: number; domains: number; aliases: string[] }

export function Warp({ snap, updateSettings }: { snap: Snapshot; updateSettings: (p: Record<string, unknown>) => Promise<unknown> }) {
  const w = snap.warp;
  const cfg = snap.settings.warp;
  const { busy, error, run } = useAction();
  const set = (patch: Partial<WarpSettings>) => run('set', () => updateSettings({ warp: { ...cfg, ...patch } }));

  const tone = w.ready ? 'ok' : w.running ? 'warn' : 'neutral';
  // Туннелем пользуются: игровой режим (эта страница) и маршрут Telegram «Через WARP» (раздел Telegram)
  const tgWarp = snap.settings.tg.enabled && snap.settings.tg.mode === 'warp';
  const users = [cfg.enabled && 'игры', tgWarp && 'Telegram'].filter(Boolean).join(' и ');

  return (
    <>
      <PageHeader
        title="WARP · игровой режим"
        description="Часть игр блокируется по IP-адресам серверов — пакетный обход тут бессилен. Такой трафик заворачивается в туннель Cloudflare WARP: WireGuard по UDP с запасными портами, а если провайдер режет UDP — MASQUE по TCP 443. Остальной трафик идёт напрямую. Движок — порт z2k-warpd."
      />

      {!w.installed && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-[13.5px] text-warn">
          <TriangleAlert className="size-5 shrink-0" />Движок WARP не найден в resources/bin (z2k-warpd.exe, wintun.dll). Соберите его: npm run build:warpd.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card>
          <div className="flex items-start gap-4">
            <div className={cx('grid size-14 place-items-center rounded-2xl', w.ready ? 'bg-ok/15 text-ok' : 'bg-panel-2 text-muted')}><Cloud className="size-7" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[17px] font-semibold">Туннель WARP <Dot tone={tone} /></div>
              <div className="mt-0.5 text-[13px] text-muted">
                {w.ready ? `работает · ${w.transport === 'h2' ? 'MASQUE (TCP 443)' : `WireGuard${w.endpoint ? ` ${w.endpoint}` : ''}`}` : w.running ? 'подключение…' : 'выключен'}
                {w.since && w.ready ? ` · ${formatAgo(w.since)}` : ''}
              </div>
              {w.running && users && <div className="mt-1 text-[12.5px] text-muted">Используют туннель: <b className="text-fg">{users}</b></div>}
              {w.colo && <div className="mt-1 text-[12.5px] text-muted">Узел Cloudflare: {w.colo}</div>}
              {w.error && <div className="selectable mt-2 text-[12.5px] text-bad">{w.error}</div>}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant={cfg.enabled ? 'danger' : 'primary'} icon={<Power className="size-4" />} busy={busy === 'set'} disabled={!w.installed} onClick={() => set({ enabled: !cfg.enabled })}>
              {tgWarp ? (cfg.enabled ? 'Выключить для игр' : 'Включить для игр') : cfg.enabled ? 'Выключить WARP' : 'Включить WARP'}
            </Button>
            {w.registered && !cfg.enabled && !w.running && (
              <Button variant="ghost" busy={busy === 'forget'} onClick={() => confirm('Удалить регистрацию устройства в Cloudflare? При следующем включении будет заведено новое.') && run('forget', () => api.invoke('warp:forget'))}>Сбросить регистрацию</Button>
            )}
          </div>
          {tgWarp && !cfg.enabled && (
            <p className="mt-3 text-[12.5px] leading-snug text-muted">Туннель поднят для Telegram (раздел «Telegram» → маршрут «Через WARP»). Игры и свои адреса в него пока не идут — включите игровой режим, если нужно. Выключить туннель целиком можно, сменив маршрут Telegram.</p>
          )}
          {!cfg.fullTunnel && cfg.games.length === 0 && cfg.enabled && (
            <p className="mt-3 text-[12.5px] text-warn">Ни одна игра не выбрана и своих адресов нет — в туннель ничего не пойдёт.</p>
          )}
          <ErrorNote error={error} />
        </Card>

        <Card title="Режим">
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 text-[12.5px] text-muted">Что заворачивать в WARP</div>
              <Select value={cfg.fullTunnel ? 'full' : 'split'} onChange={(v) => set({ fullTunnel: v === 'full' })} className="w-full" options={[
                { value: 'split', label: 'Только выбранные игры, адреса и домены' },
                { value: 'full', label: 'Весь трафик компьютера' },
              ]} />
              {cfg.fullTunnel && <p className="mt-1.5 text-[12px] leading-snug text-warn">Весь интернет пойдёт через Cloudflare; при падении туннеля маршруты снимаются и трафик идёт напрямую.</p>}
            </div>
            <div>
              <div className="mb-1.5 text-[12.5px] text-muted">Транспорт</div>
              <Select value={cfg.transport} onChange={(v) => set({ transport: v as WarpSettings['transport'] })} className="w-full" options={[
                { value: 'auto', label: 'Автоматически (WireGuard → MASQUE)' },
                { value: 'wg', label: 'Только WireGuard (UDP)' },
                { value: 'h2', label: 'Только MASQUE (TCP 443)' },
              ]} />
            </div>
          </div>
        </Card>
      </div>

      <WarpPlusCard installed={w.installed} />

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Маршрутов в туннель" value={w.routes} />
        <Stat label="Получено" value={formatBytes(w.rx)} />
        <Stat label="Отправлено" value={formatBytes(w.tx)} />
        <Stat label="Handshake" value={w.handshakeAge === null || w.handshakeAge < 0 ? '—' : `${w.handshakeAge} с назад`} hint={w.addr ? `адрес ${w.addr}` : undefined} />
      </div>

      {!cfg.fullTunnel && <GamesCard cfg={cfg} set={set} />}
      {!cfg.fullTunnel && <UserLists />}
    </>
  );
}

function GamesCard({ cfg, set }: { cfg: WarpSettings; set: (p: Partial<WarpSettings>) => Promise<unknown> }) {
  const [games, setGames] = useState<GameInfo[]>([]);
  const [q, setQ] = useState('');
  const { busy, error, run } = useAction();
  const load = useCallback(() => api.invoke<GameInfo[]>('warp:games').then(setGames).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? games.filter((g) => g.title.toLowerCase().includes(t) || g.aliases.some((a) => a.toLowerCase().includes(t))) : games;
  }, [games, q]);
  const toggle = (id: string) => set({ games: cfg.games.includes(id) ? cfg.games.filter((g) => g !== id) : [...cfg.games, id] });

  return (
    <Card
      className="mt-4"
      title={`Игры · выбрано ${cfg.games.length}`}
      subtitle="Списки серверов игр из YOZH3G/ru-gaming-blocklist (очищенный форк, без частных сетей). Ничего не выбрано по умолчанию."
      actions={
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="игра" className="w-44 pl-8" />
          </div>
          <Button icon={<RefreshCw className="size-4" />} busy={busy === 'upd'} onClick={() => run('upd', async () => { await api.invoke('warp:games-update'); await load(); })}>Обновить списки</Button>
        </>
      }
    >
      {games.length === 0 ? (
        <p className="text-[13px] text-muted">Списки игр ещё не загружены — нажмите «Обновить списки».</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((g) => {
            const on = cfg.games.includes(g.id);
            return (
              <button key={g.id} onClick={() => void toggle(g.id)} className={cx('flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition', on ? 'border-accent/50 bg-accent/10' : 'border-line bg-bg/40 hover:border-[#3a4658]')}>
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-medium">{g.title}</span>
                  <span className="block truncate text-[11.5px] text-muted">{g.aliases.slice(0, 4).join(', ') || '—'}</span>
                </span>
                <span className="flex shrink-0 gap-1">
                  {g.ips > 0 && <Badge>{g.ips} IP</Badge>}
                  {g.domains > 0 && <Badge>{g.domains} дом.</Badge>}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <ErrorNote error={error} />
    </Card>
  );
}

function UserLists() {
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <UserList kind="ips" title="Свои адреса" hint="IPv4 или подсеть CIDR, по одной на строку. Частные сети не принимаются." placeholder={'203.0.113.10\n198.51.100.0/24'} />
      <UserList kind="domains" title="Свои домены" hint="example.com — точное имя; *.example.com — все поддомены (по ответам DNS, которые видит Windows)." placeholder={'game.example.com\n*.example.net'} />
    </div>
  );
}

function UserList({ kind, title, hint, placeholder }: { kind: 'ips' | 'domains'; title: string; hint: string; placeholder: string }) {
  const [text, setText] = useState('');
  const [orig, setOrig] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    api.invoke<string[]>('warp:user-read', kind).then((l) => { setText(l.join('\n')); setOrig(l.join('\n')); }).catch(() => undefined);
  }, [kind]);
  return (
    <Card title={title} subtitle={hint} actions={<Button variant="primary" icon={<Save className="size-4" />} busy={busy === 'save'} disabled={text === orig} onClick={() => run('save', async () => {
      const r = await api.invoke<{ saved: number; rejected: string[] }>('warp:user-write', kind, text.split(/\r?\n/));
      setNote(r.rejected.length ? `Не приняты: ${r.rejected.join(', ')}` : `Сохранено: ${r.saved}`);
      const fresh = await api.invoke<string[]>('warp:user-read', kind);
      setText(fresh.join('\n'));
      setOrig(fresh.join('\n'));
    })}>Сохранить</Button>}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder={placeholder} className="selectable h-40 w-full resize-y rounded-lg border border-line bg-bg p-3 font-mono text-[12.5px] outline-none focus:border-accent" />
      {note && <p className="mt-2 text-[12.5px] text-muted">{note}</p>}
      <ErrorNote error={error} />
    </Card>
  );
}

const PLANS: Record<string, string> = { free: 'бесплатный WARP', limited: 'WARP+', unlimited: 'WARP+ Unlimited', team: 'Zero Trust' };

function WarpPlusCard({ installed }: { installed: boolean }) {
  const [acc, setAcc] = useState<WarpAccount | null>(null);
  const [key, setKey] = useState('');
  const [ok, setOk] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => { api.invoke<WarpAccount>('warp:account').then(setAcc).catch(() => undefined); }, []);

  const apply = (k: string) => run(k ? 'apply' : 'check', async () => {
    const a = await api.invoke<WarpAccount>('warp:license', k);
    setAcc(a);
    setKey('');
    setOk(k ? (a.plus ? `Ключ применён — ${PLANS[a.plan ?? ''] ?? a.plan}` : 'Ключ принят, но аккаунт остался бесплатным') : 'Сведения обновлены');
  });

  const gb = (n: number) => (n / 1024 ** 3).toFixed(n >= 100 * 1024 ** 3 ? 0 : 1);
  return (
    <Card
      className="mt-4"
      title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-warn" />WARP+</span>}
      subtitle="Ключ лицензии WARP+ (приложение 1.1.1.1 → Аккаунт → Ключ) привязывает это устройство к вашему аккаунту: быстрее маршруты Cloudflare Argo. Регистрация и туннель не меняются, перезапуск не нужен. На один аккаунт — до 5 устройств."
      actions={acc && <Badge tone={acc.plus ? 'ok' : 'neutral'}>{acc.plan ? PLANS[acc.plan] ?? acc.plan : 'не проверялся'}</Badge>}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && void apply(key)} placeholder="xxxxxxxx-xxxxxxxx-xxxxxxxx" className="w-80 font-mono" autoComplete="off" />
        <Button variant="primary" icon={<KeyRound className="size-4" />} busy={busy === 'apply'} disabled={!installed || !key.trim()} onClick={() => void apply(key)}>Применить ключ</Button>
        <Button variant="ghost" busy={busy === 'check'} disabled={!installed} onClick={() => void apply('')}>Проверить аккаунт</Button>
      </div>
      {acc && (
        <div className="mt-3 space-y-1 text-[12.5px] text-muted">
          {acc.licenseSaved && <div>Ключ сохранён и будет привязан заново, если устройство придётся перерегистрировать.</div>}
          {acc.plan === 'limited' && acc.quota > 0 && <div>Трафик WARP+: осталось <b className="text-fg">{gb(acc.premiumData)} ГБ</b> из {gb(acc.quota)} ГБ</div>}
          {acc.checked && <div>Проверено {formatAgo(acc.checked)}</div>}
          {acc.error && <div className="text-warn">{acc.error}</div>}
        </div>
      )}
      {ok && <p className="mt-2 text-[12.5px] text-ok">{ok}</p>}
      <ErrorNote error={error} />
    </Card>
  );
}
