'use client';

import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Play, Power, Activity, CloudUpload, KeyRound, FolderOpen, Server } from 'lucide-react';
import type { Snapshot, TgSettings } from '@shared/types';
import { api, formatBytes, useAction } from '@/lib/api';
import { Badge, Button, Card, cx, Dot, ErrorNote, Input, PageHeader, Select, Stat, Toggle } from '@/components/ui';

interface DcProbe { dc: number; ok: boolean; ms: number; detail: string }

export function Telegram({ snap, updateSettings }: { snap: Snapshot; updateSettings: (p: Record<string, unknown>) => Promise<unknown> }) {
  const { tg } = snap;
  const cfg = snap.settings.tg;
  const [draft, setDraft] = useState<TgSettings>(cfg);
  const [link, setLink] = useState('');
  const [probes, setProbes] = useState<DcProbe[] | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => setDraft(cfg), [cfg]);
  useEffect(() => { api.invoke<string>('tg:link').then(setLink).catch(() => undefined); }, [cfg]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(cfg);
  const save = () => run('save', () => updateSettings({ tg: draft }));

  return (
    <>
      <PageHeader
        title="Telegram"
        description="Локальный SOCKS5-прокси для Telegram Desktop. Трафик идёт через WebSocket самого Telegram (kwsN.web.telegram.org), а если Telegram заблокирован по IP целиком — через ваш релей: свой VPS с релеем z2k или Cloudflare Worker. В прозрачном режиме, как в z2k для роутеров, через прокси идут и программы без его настройки: Telegram Desktop, веб-версия в браузере, другие клиенты."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.1fr_1fr]">
        <Card>
          <div className="flex items-center gap-3 text-[17px] font-semibold">
            <Dot tone={tg.running ? 'ok' : 'neutral'} />
            {tg.running ? `Прокси работает · ${tg.listen}` : 'Прокси выключен'}
          </div>
          {tg.lastError && <ErrorNote error={tg.lastError} />}
          {tg.running && cfg.mode === 'warp' && (
            <div className="mt-2 flex items-center gap-2 text-[13px] text-muted">
              <Dot tone={snap.warp.ready ? 'ok' : snap.warp.error ? 'bad' : 'warn'} />
              {snap.warp.ready
                ? `WARP подключён${snap.warp.colo ? ` (${snap.warp.colo})` : ''}: подсети Telegram идут через туннель у всех программ`
                : snap.warp.error ? `WARP: ${snap.warp.error}` : 'WARP подключается…'}
            </div>
          )}
          {tg.running && cfg.transparent && cfg.mode !== 'warp' && (
            <div className="mt-2 flex items-center gap-2 text-[13px] text-muted">
              <Dot tone={tg.transparent.running ? 'ok' : 'bad'} />
              {tg.transparent.running
                ? `Прозрачный режим: перехват работает${tg.transparent.active ? ` · соединений ${tg.transparent.active}` : ''}`
                : `Прозрачный режим не работает${tg.transparent.error ? `: ${tg.transparent.error}` : ''}`}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant={tg.running ? 'danger' : 'primary'} icon={<Power className="size-4" />} busy={busy === 'toggle'} onClick={() => run('toggle', () => updateSettings({ tg: { ...cfg, enabled: !tg.running } }))}>
              {tg.running ? 'Выключить' : 'Включить'}
            </Button>
            <Button variant="primary" icon={<ExternalLink className="size-4" />} disabled={!tg.running} onClick={() => api.invoke('tg:connect')}>Подключить Telegram</Button>
            <Button icon={<Activity className="size-4" />} busy={busy === 'test'} disabled={!tg.running} onClick={() => run('test', async () => setProbes(await api.invoke<DcProbe[]>('tg:selftest')))}>Проверить DC</Button>
          </div>

          <div className="mt-5 rounded-lg border border-line bg-bg/60 p-3">
            <div className="text-[12.5px] text-muted">Ссылка для Telegram Desktop (откроет диалог добавления прокси)</div>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="selectable flex-1 truncate font-mono text-[12.5px]">{link}</code>
              <Button variant="ghost" icon={<Copy className="size-4" />} onClick={() => { void navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Скопировано' : 'Копировать'}</Button>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">Вручную: Настройки → Продвинутые настройки → Тип соединения → SOCKS5, сервер {draft.host === '0.0.0.0' ? '127.0.0.1' : draft.host}, порт {draft.port}.</p>
          </div>

          {probes && (
            <div className="mt-5 grid grid-cols-7 gap-1.5">
              {probes.map((p) => (
                <div key={p.dc} title={p.detail} className={cx('rounded-lg border px-2 py-2 text-center', p.ok ? 'border-ok/40 bg-ok/10' : 'border-bad/40 bg-bad/10')}>
                  <div className="text-[12px] text-muted">{p.dc < 0 ? `DC${-p.dc} media` : `DC${p.dc}`}</div>
                  <div className={cx('mt-0.5 text-[13px] font-semibold tabular-nums', p.ok ? 'text-ok' : 'text-bad')}>{p.ok ? `${p.ms} мс` : 'нет'}</div>
                </div>
              ))}
            </div>
          )}
          <ErrorNote error={error} />
        </Card>

        <Card title="Параметры" actions={dirty && <Button variant="primary" busy={busy === 'save'} onClick={save}>Применить</Button>}>
          <div className="space-y-4">
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <div>
                <div className="mb-1.5 text-[12.5px] text-muted">Адрес</div>
                <Select value={draft.host} onChange={(host) => setDraft({ ...draft, host })} options={[{ value: '127.0.0.1', label: '127.0.0.1 — только этот компьютер' }, { value: '0.0.0.0', label: '0.0.0.0 — вся локальная сеть' }]} className="w-full" />
              </div>
              <div>
                <div className="mb-1.5 text-[12.5px] text-muted">Порт</div>
                <Input type="number" min={1024} max={65535} value={draft.port} onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })} className="w-full" />
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[12.5px] text-muted">Маршрут до Telegram</div>
              <Select value={draft.mode} onChange={(mode) => setDraft({ ...draft, mode: mode as TgSettings['mode'] })} className="w-full" options={[
                { value: 'warp', label: 'Через WARP (рекомендуется)' },
                { value: 'ws', label: 'WebSocket Telegram' },
                { value: 'relay', label: 'Свой VPS-релей (релей z2k)' },
                { value: 'cfworker', label: 'Свой Cloudflare Worker' },
                { value: 'direct', label: 'Напрямую к дата-центрам' },
              ]} />
            </div>
            {draft.mode === 'warp' && (
              <p className="text-[12.5px] leading-relaxed text-muted">Подсети Telegram заворачиваются в туннель WARP системными маршрутами — для Telegram Desktop без настроек прокси, веб-версии в браузере и звонков. Нужен, когда Telegram заблокирован по IP целиком и WebSocket не проходит. Устройство WARP регистрируется автоматически, отдельный аккаунт не нужен.</p>
            )}
            {draft.mode === 'relay' && (
              <>
                <div>
                  <div className="mb-1.5 text-[12.5px] text-muted">Адрес релея</div>
                  <Input value={draft.relayUrl} onChange={(e) => setDraft({ ...draft, relayUrl: e.target.value })} className="w-full font-mono" placeholder="wss://1.2.3.4.nip.io/ws" />
                </div>
                <div>
                  <div className="mb-1.5 text-[12.5px] text-muted">Секрет (выводит install.sh, хранится на VPS в /etc/z2k-relay/secret)</div>
                  <Input type="password" value={draft.relaySecret} onChange={(e) => setDraft({ ...draft, relaySecret: e.target.value })} className="w-full font-mono" />
                </div>
              </>
            )}
            {draft.mode === 'cfworker' && (
              <>
                <div>
                  <div className="mb-1.5 text-[12.5px] text-muted">Адрес Worker</div>
                  <Input value={draft.cfWorkerUrl} onChange={(e) => setDraft({ ...draft, cfWorkerUrl: e.target.value })} className="w-full font-mono" placeholder="wss://z2k-tg-relay.<поддомен>.workers.dev/ws" />
                </div>
                <div>
                  <div className="mb-1.5 text-[12.5px] text-muted">Секрет (переменная TUNNEL_SECRET у Worker)</div>
                  <Input type="password" value={draft.cfWorkerSecret} onChange={(e) => setDraft({ ...draft, cfWorkerSecret: e.target.value })} className="w-full font-mono" />
                </div>
              </>
            )}
            {draft.mode === 'ws' && (
              <>
                <div>
                  <div className="mb-1.5 text-[12.5px] text-muted">IP фронта web.telegram.org (пусто — через DNS)</div>
                  <Input value={draft.wsFrontIp} onChange={(e) => setDraft({ ...draft, wsFrontIp: e.target.value })} className="w-full font-mono" placeholder="149.154.167.220" />
                </div>
                <Toggle checked={draft.wsFallbackDirect} onChange={(wsFallbackDirect) => setDraft({ ...draft, wsFallbackDirect })} label="Запасной путь напрямую" hint="Если WebSocket недоступен — соединяться с DC напрямую" />
              </>
            )}
            {draft.mode !== 'warp' && <Toggle checked={draft.transparent} onChange={(transparent) => setDraft({ ...draft, transparent })} label="Прозрачный режим" hint="Соединения любых программ на этом компьютере к серверам Telegram перехватываются (WinDivert) и идут через прокси — Telegram Desktop без настройки прокси, веб-версия в браузере. Веб-версии нужен релей (свой VPS или Cloudflare Worker): в режиме WebSocket её соединения идут напрямую." />}
            <Toggle checked={draft.auth.enabled} onChange={(enabled) => setDraft({ ...draft, auth: { ...draft.auth, enabled } })} label="Логин и пароль" hint="Имеет смысл, если прокси открыт для локальной сети" />
            {draft.auth.enabled && (
              <div className="grid grid-cols-2 gap-3">
                <Input placeholder="логин" value={draft.auth.user} onChange={(e) => setDraft({ ...draft, auth: { ...draft.auth, user: e.target.value } })} />
                <Input placeholder="пароль" type="password" value={draft.auth.pass} onChange={(e) => setDraft({ ...draft, auth: { ...draft.auth, pass: e.target.value } })} />
              </div>
            )}
          </div>
        </Card>
      </div>

      {(draft.mode === 'relay' || cfg.mode === 'relay') && <RelayCard />}
      {(draft.mode === 'cfworker' || cfg.mode === 'cfworker') && <CfWorkerCard onDeployed={(url, secret) => setDraft((d) => ({ ...d, mode: 'cfworker', cfWorkerUrl: url, cfWorkerSecret: secret }))} />}

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Активных соединений" value={tg.connections} />
        <Stat label="Всего соединений" value={tg.totalConnections} />
        <Stat label="Отправлено" value={formatBytes(tg.bytesUp)} />
        <Stat label="Получено" value={formatBytes(tg.bytesDown)} />
      </div>

      <Card className="mt-4" title="Дата-центры" subtitle="Telegram держит отдельные соединения к основному DC аккаунта и к media-DC для файлов.">
        {tg.dcs.length === 0 ? (
          <p className="text-[13px] text-muted">Соединений ещё не было. Включите прокси и подключите к нему Telegram.</p>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] uppercase tracking-wide text-muted">
              <tr className="border-b border-line"><th className="py-2 font-medium">DC</th><th className="font-medium">Активно</th><th className="font-medium">Всего</th><th className="font-medium">↑</th><th className="font-medium">↓</th><th className="font-medium">Последняя ошибка</th></tr>
            </thead>
            <tbody>
              {tg.dcs.map((d) => (
                <tr key={d.dc} className="border-b border-line/50 last:border-0">
                  <td className="py-2"><Badge tone="accent">{d.dc.endsWith('m') ? `DC${d.dc.slice(0, -1)} media` : /^\d+$/.test(d.dc) ? `DC${d.dc}` : d.dc}</Badge></td>
                  <td className="tabular-nums">{d.active}</td>
                  <td className="tabular-nums">{d.total}</td>
                  <td className="tabular-nums">{formatBytes(d.bytesUp)}</td>
                  <td className="tabular-nums">{formatBytes(d.bytesDown)}</td>
                  <td className="max-w-[260px] truncate text-muted" title={d.lastError ?? ''}>{d.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="mt-3 text-[12px] text-muted"><Play className="mr-1 inline size-3" />Прокси и прозрачный режим передают только TCP: звонки Telegram (UDP/WebRTC) идут мимо них, напрямую.</p>
    </>
  );
}

function RelayCard() {
  const [dir, setDir] = useState('');
  const [ip, setIp] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.invoke<string>('tg:relay-dir').then(setDir).catch(() => undefined); }, []);
  const host = ip.trim() || 'IP_VPS';
  const cmd = `scp "${dir}\\z2k-vps-relay" "${dir}\\install.sh" root@${host}:/root/\nssh root@${host} "sh /root/install.sh"`;

  return (
    <Card className="mt-4" title="Свой релей на VPS" subtitle="Тот же релей, через который Telegram работает у z2k на роутерах (vps-relay из necronicle/z2k), только на вашем сервере и с вашим секретом. Подходит любой VPS за пределами РФ: Debian 12+ или Ubuntu 22.04+, x86_64, доступ root по SSH. Хватит самого дешёвого тарифа.">
      <ol className="list-decimal space-y-2 pl-5 text-[12.5px] text-muted">
        <li>
          Файлы релея (бинарник и install.sh) лежат в папке программы.
          <Button variant="ghost" className="ml-2" icon={<FolderOpen className="size-4" />} onClick={() => api.invoke('tg:relay-open')}>Открыть папку</Button>
        </li>
        <li>
          Скопируйте их на VPS и запустите установку — в PowerShell (OpenSSH есть в Windows 10/11):
          <div className="mt-2 flex items-center gap-2">
            <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="IP вашего VPS" className="w-48 font-mono" />
            <Button variant="ghost" icon={<Copy className="size-4" />} onClick={() => { void navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Скопировано' : 'Копировать команды'}</Button>
          </div>
          <pre className="selectable mt-2 overflow-x-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[12px] text-fg">{cmd}</pre>
        </li>
        <li>Скрипт поставит релей и caddy (сертификат Let&apos;s Encrypt на имя <code>IP.nip.io</code>), проверит тракт и выведет адрес и секрет — вставьте их в параметры выше и нажмите «Применить».</li>
      </ol>
      <p className="mt-3 flex items-center gap-1.5 text-[12px] text-muted"><Server className="size-3.5" />Релей соединяется только с подсетями Telegram и пускает только по вашему секрету — открытым прокси он не становится.</p>
    </Card>
  );
}

function CfWorkerCard({ onDeployed }: { onDeployed: (url: string, secret: string) => void }) {
  const [token, setToken] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const copy = async (what: string, text: string) => { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1500); };

  return (
    <Card className="mt-4" title="Свой релей на Cloudflare Workers" subtitle="Как в z2k (апрель 2026): мультиплексированный туннель TCP поверх WebSocket до вашего Worker, а уже он соединяется с дата-центрами Telegram. Бесплатного тарифа Workers хватает для переписки; активная загрузка медиа может упираться в лимиты бесплатного плана.">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div>
          <div className="mb-2 text-[13.5px] font-medium">Автоматически</div>
          <ol className="mb-3 list-decimal space-y-1 pl-5 text-[12.5px] text-muted">
            <li>Создайте API-токен по шаблону «Edit Cloudflare Workers» — <a className="text-accent underline" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer noopener">dash.cloudflare.com/profile/api-tokens</a></li>
            <li>Вставьте его сюда — приложение опубликует Worker, задаст случайный секрет и включит адрес *.workers.dev. Токен не сохраняется.</li>
          </ol>
          <div className="flex gap-2">
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="API-токен Cloudflare" className="flex-1 font-mono" />
            <Button variant="primary" icon={<CloudUpload className="size-4" />} busy={busy === 'deploy'} disabled={!token.trim()} onClick={() => run('deploy', async () => {
              const r = await api.invoke<{ url: string; account: string }>('tg:cf-deploy', token);
              const st = await api.invoke<{ tg: TgSettings }>('app:snapshot');
              onDeployed(r.url, st.tg.cfWorkerSecret);
              setToken('');
              setResult(`Опубликовано в аккаунт «${r.account}»: ${r.url}. Новый адрес *.workers.dev может заработать через 1–2 минуты.`);
            })}>Опубликовать</Button>
          </div>
          {result && <p className="selectable mt-3 text-[12.5px] text-ok">{result}</p>}
          <ErrorNote error={error} />
        </div>
        <div>
          <div className="mb-2 text-[13.5px] font-medium">Вручную</div>
          <ol className="list-decimal space-y-1.5 pl-5 text-[12.5px] text-muted">
            <li>Cloudflare → Workers &amp; Pages → Create → Worker, вставьте код.</li>
            <li>Settings → Variables and Secrets: секрет <code>TUNNEL_SECRET</code>.</li>
            <li>Впишите адрес вида <code>wss://имя.поддомен.workers.dev/ws</code> и тот же секрет в параметры выше.</li>
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button icon={<Copy className="size-4" />} onClick={() => run('src', async () => copy('src', await api.invoke<string>('tg:cf-source')))}>{copied === 'src' ? 'Скопировано' : 'Код Worker'}</Button>
            <Button icon={<KeyRound className="size-4" />} onClick={() => run('sec', async () => copy('sec', await api.invoke<string>('tg:cf-secret')))}>{copied === 'sec' ? 'Скопировано' : 'Сгенерировать секрет'}</Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
