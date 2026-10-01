'use client';

import { useState } from 'react';
import { FileCode2 } from 'lucide-react';
import type { Settings, Snapshot } from '@shared/types';
import { api, useAction } from '@/lib/api';
import { Button, Card, ErrorNote, Input, PageHeader, Toggle } from '@/components/ui';

export function SettingsView({ snap, updateSettings }: { snap: Snapshot; updateSettings: (p: Record<string, unknown>) => Promise<unknown> }) {
  const s = snap.settings;
  const { busy, error, run } = useAction();
  const [args, setArgs] = useState<string[] | null>(null);
  const set = (patch: Partial<Settings>) => run('set', () => updateSettings(patch));
  const cat = (k: keyof Settings['categories'], v: boolean) => set({ categories: { ...s.categories, [k]: v } });

  return (
    <>
      <PageHeader title="Настройки" description="Изменения, касающиеся движка, применяются перезапуском обхода автоматически." />
      <ErrorNote error={error} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Категории обхода" subtitle="Какие пулы стратегий z2k включены. Выключенная категория не обрабатывается совсем.">
          <div className="space-y-4">
            <Toggle checked={s.categories.rkn} onChange={(v) => cat('rkn', v)} label="Заблокированные сайты (RKN, Discord, свои домены)" hint="TLS на 443 и CF-портах · 50 стратегий" />
            <Toggle checked={s.categories.youtube} onChange={(v) => cat('youtube', v)} label="YouTube" hint="youtube.com, ytimg · 22 стратегии" />
            <Toggle checked={s.categories.googlevideo} onChange={(v) => cat('googlevideo', v)} label="YouTube видео (googlevideo)" hint="видеопоток · 22 стратегии" />
            <Toggle checked={s.categories.quic} onChange={(v) => cat('quic', v)} label="QUIC (UDP 443)" hint="YouTube и сайты из списков по QUIC" />
            <Toggle checked={s.categories.discordVoice} onChange={(v) => cat('discordVoice', v)} label="Голос Discord" hint="UDP голос/видео и STUN" />
            <Toggle checked={s.categories.http} onChange={(v) => cat('http', v)} label="HTTP (порт 80)" hint="незашифрованные запросы к сайтам из списков" />
          </div>
        </Card>

        <Card title="Движок" subtitle="Тонкая настройка winws2.">
          <div className="space-y-4">
            <Toggle checked={s.dynamicTtl} onChange={(v) => set({ dynamicTtl: v })} label="Динамический TTL фейков" hint="TTL поддельного пакета = TTL настоящего − 1 (z2k_dynamic_ttl)" />
            <Toggle checked={s.circularReset} onChange={(v) => set({ circularReset: v })} label="Сброс зависших соединений при ротации" hint="RST клиенту после неудачи, чтобы браузер сразу повторил запрос" />
            <Toggle checked={s.ipv6} onChange={(v) => set({ ipv6: v })} label="IPv6" hint="Обрабатывать IPv6-трафик" />
            <Toggle checked={s.filterLan} onChange={(v) => set({ filterLan: v })} label="Не трогать локальную сеть" hint="Исключить частные адреса из перехвата" />
            <Toggle checked={s.dnsFix} onChange={(v) => set({ dnsFix: v })} label="Обход блокировки по IP (подмена DNS)" hint="Instagram, WhatsApp, Facebook и домены из списка «Обход блокировки по IP»: движок заменяет заблокированный адрес на рабочий прямо в ответе DNS. Системные файлы не меняются; не действует при «безопасном DNS» (DoH) в браузере" />
            <Toggle checked={s.debugEngine} onChange={(v) => set({ debugEngine: v })} label="Отладочный лог движка" hint="Подробный лог winws2 в папку данных (большой объём)" />
          </div>
          <div className="mt-5 flex gap-2">
            <Button icon={<FileCode2 className="size-4" />} busy={busy === 'args'} onClick={() => run('args', async () => setArgs(await api.invoke<string[]>('engine:args')))}>Показать аргументы winws2</Button>
          </div>
        </Card>

        <DnsCard s={s} set={set} busy={busy === 'set'} />

        <Card title="Приложение">
          <div className="space-y-4">
            <Toggle checked={s.engineAutoStart} onChange={(v) => set({ engineAutoStart: v })} label="Включать обход при запуске" />
            <Toggle checked={s.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} label="Запускать при входе в Windows" hint="Через планировщик заданий, с правами администратора, без запроса UAC" />
            <Toggle checked={s.startMinimized} onChange={(v) => set({ startMinimized: v })} disabled={!s.launchAtLogin} label="Сворачивать в трей при автозапуске" />
            <Toggle checked={s.minimizeToTray} onChange={(v) => set({ minimizeToTray: v })} label="Сворачивать в трей" hint="Свёрнутое окно пропадает с панели задач — открыть можно кликом по значку в трее" />
            <Toggle checked={s.closeToTray} onChange={(v) => set({ closeToTray: v })} label="Закрытие окна сворачивает в трей" hint="Обход и прокси продолжают работать" />
            <Toggle checked={s.listsAutoUpdate} onChange={(v) => set({ listsAutoUpdate: v })} label="Обновлять списки раз в сутки" />
          </div>
        </Card>
      </div>

      {args && (
        <Card className="mt-4" title={`Аргументы winws2 · ${args.length}`} actions={<Button variant="ghost" onClick={() => setArgs(null)}>Скрыть</Button>}>
          <pre className="selectable max-h-[420px] overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px] leading-relaxed text-muted">{args.join('\n')}</pre>
        </Card>
      )}
    </>
  );
}

function DnsCard({ s, set, busy }: { s: Settings; set: (p: Partial<Settings>) => Promise<unknown>; busy: boolean }) {
  const [url, setUrl] = useState(s.doh.url);
  const valid = (() => {
    try {
      const u = new URL(url.trim());
      return u.protocol === 'https:' && !!u.hostname;
    } catch {
      return false;
    }
  })();
  return (
    <Card title="DNS" subtitle="Пока работает обход, DNS компьютера идёт через DNS-over-HTTPS: провайдер не видит и не подменяет ответы. Приложение поднимает локальный DNS на 127.0.0.1 и переключает на него сетевые адаптеры; при остановке обхода и выходе прежние настройки (DHCP или свои) возвращаются.">
      <div className="space-y-4">
        <Toggle checked={s.doh.enabled} onChange={(v) => set({ doh: { ...s.doh, enabled: v } })} label="DNS через DoH при работе обхода" />
        <div>
          <div className="mb-1.5 text-[12.5px] text-muted">Адрес DoH-сервера</div>
          <div className="flex gap-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1 font-mono" placeholder="https://xbox-dns.ru/dns-query" />
            <Button variant="primary" busy={busy} disabled={!valid || url.trim() === s.doh.url} onClick={() => set({ doh: { ...s.doh, url: url.trim() } })}>Сохранить</Button>
          </div>
          {!valid && <p className="mt-1 text-[12px] text-bad">Нужен адрес вида https://сервер/dns-query</p>}
        </div>
      </div>
    </Card>
  );
}
