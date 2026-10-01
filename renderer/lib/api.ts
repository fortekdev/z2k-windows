'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutopickJob, EngineState, LogEntry, Settings, Snapshot, TgState, WarpState } from '@shared/types';

interface Bridge {
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>;
  on: (event: string, cb: (payload: unknown) => void) => () => void;
}

declare global {
  interface Window {
    z2k?: Bridge;
  }
}

function bridge(): Bridge {
  if (typeof window === 'undefined' || !window.z2k) {
    // Открыто в обычном браузере (next dev без Electron) — команды недоступны
    return {
      invoke: () => Promise.reject(new Error('Мост Electron недоступен — откройте приложение через Electron')),
      on: () => () => undefined,
    };
  }
  return window.z2k;
}

export const api = {
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => bridge().invoke<T>(channel, ...args),
  on: (event: string, cb: (payload: unknown) => void) => bridge().on(event, cb),
};

export function useEvent<T>(event: string, cb: (payload: T) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => api.on(event, (p) => ref.current(p as T)), [event]);
}

/** Общее живое состояние: движок, Telegram, настройки */
export function useSnapshot() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.invoke<Snapshot>('app:snapshot').then(setSnap).catch((e: Error) => setError(e.message));
  }, []);
  useEvent<EngineState>('engine', (engine) => setSnap((s) => (s ? { ...s, engine } : s)));
  useEvent<TgState>('tg', (tg) => setSnap((s) => (s ? { ...s, tg } : s)));
  useEvent<Settings>('settings', (settings) => setSnap((s) => (s ? { ...s, settings } : s)));
  useEvent<WarpState>('warp', (warp) => setSnap((s) => (s ? { ...s, warp } : s)));
  const updateSettings = useCallback(async (patch: Record<string, unknown>) => {
    const settings = await api.invoke<Settings>('settings:update', patch);
    setSnap((s) => (s ? { ...s, settings } : s));
    return settings;
  }, []);
  return { snap, error, updateSettings };
}

export function useLogs(source?: string) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  useEffect(() => {
    api.invoke<LogEntry[]>('logs:tail', source).then(setLogs).catch(() => undefined);
  }, [source]);
  useEvent<LogEntry>('log', (e) => {
    if (source && e.source !== source) return;
    setLogs((l) => (l.length > 1500 ? [...l.slice(-1200), e] : [...l, e]));
  });
  return logs;
}

export function useAutopick() {
  const [job, setJob] = useState<AutopickJob | null>(null);
  useEffect(() => {
    api.invoke<AutopickJob | null>('autopick:current').then(setJob).catch(() => undefined);
  }, []);
  useEvent<AutopickJob>('autopick', setJob);
  return job;
}

/** Асинхронное действие с флагом занятости и текстом ошибки */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method 'z2k': (Error: )?/, ''));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, error, run, setError };
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
  return `${(n / 1024 ** 3).toFixed(2)} ГБ`;
}

export function formatAgo(ts: number | null) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return `${Math.round(s / 86400)} дн назад`;
}

export function statusText(s: string) {
  return ({ running: 'работает', stopped: 'выключен', starting: 'запуск…', stopping: 'остановка…', error: 'ошибка' } as Record<string, string>)[s] ?? s;
}
