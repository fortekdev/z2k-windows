// state.tsv — память автоподбора (пишут Lua z2k-state-persist и это приложение).
// Протокол как у вебпанели z2k: замок <file>.lock с unix-временем (создание эксклюзивное, протухает через 10 с),
// запись через временный файл и rename. Lua подхватывает внешние правки «на лету» (reconcile_external_edits).
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { StateRow } from '../../../shared/types';
import { data } from '../paths';

const HEADER = '# z2k autocircular state (persisted circular nstrategy)\n# key\thost\tstrategy\tts\tmode\tsni\n';

export function stateFile() {
  return join(data.state(), 'state.tsv');
}

function now() {
  return Math.floor(Date.now() / 1000);
}

export function readState(): StateRow[] {
  const f = stateFile();
  if (!existsSync(f)) return [];
  const rows: StateRow[] = [];
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split('\t');
    if (c.length < 4) continue;
    const strategy = Number(c[2]);
    if (!Number.isFinite(strategy) || strategy < 1) continue;
    const [host, fam] = c[1].split('|');
    rows.push({ pool: c[0], host, family: fam ?? '', strategy, ts: Number(c[3]) || 0, pinned: c[4] === 'frozen', raw: c });
  }
  return rows.sort((a, b) => b.ts - a.ts);
}

async function withLock<T>(fn: () => T): Promise<T> {
  const lock = stateFile() + '.lock';
  for (let i = 0; i < 50; i++) {
    try {
      const fd = openSync(lock, 'wx');
      writeSync(fd, String(now()));
      closeSync(fd);
      try {
        return fn();
      } finally {
        rmSync(lock, { force: true });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Чужой замок: пустой/битый, старше 10 с или из будущего — забираем
      try {
        const ts = Number(readFileSync(lock, 'utf8').trim());
        if (!Number.isFinite(ts) || ts <= 0 || Math.abs(now() - ts) > 10) rmSync(lock, { force: true });
      } catch { /* исчез между проверками */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('state.tsv занят — повторите позже');
}

function writeRows(rows: string[][]) {
  const f = stateFile();
  writeFileSync(f + '.ui.tmp', HEADER + rows.map((r) => r.join('\t')).join('\n') + (rows.length ? '\n' : ''));
  renameSync(f + '.ui.tmp', f);
}

function rawRows(): string[][] {
  return readState().map((r) => r.raw);
}

const key = (pool: string, host: string, family: string) => `${pool}\t${family ? `${host}|${family}` : host}`;

/** Ручной выбор стратегии (и опционально заморозка). Строка без сохранённого ts сохраняет время, если стратегия не менялась. */
export function setStrategy(pool: string, host: string, family: string, strategy: number, frozen?: boolean) {
  return withLock(() => {
    const rows = rawRows();
    const k = key(pool, host, family);
    const i = rows.findIndex((r) => `${r[0]}\t${r[1]}` === k);
    if (i >= 0) {
      const r = rows[i];
      const changed = Number(r[2]) !== strategy;
      rows[i] = [r[0], r[1], String(strategy), changed ? String(now()) : r[3], frozen === undefined ? r[4] ?? 'auto' : frozen ? 'frozen' : 'auto', r[5] ?? ''];
    } else {
      rows.push([pool, family ? `${host}|${family}` : host, String(strategy), String(now()), frozen ? 'frozen' : 'auto', '']);
    }
    writeRows(rows);
  });
}

export function setFrozen(pool: string, host: string, family: string, frozen: boolean) {
  return withLock(() => {
    const rows = rawRows();
    const k = key(pool, host, family);
    for (const r of rows) if (`${r[0]}\t${r[1]}` === k) r[4] = frozen ? 'frozen' : 'auto';
    writeRows(rows);
  });
}

/** Сброс строки: Lua вернёт хост на стратегию 1 и продолжит подбор */
export function deleteRow(pool: string, host: string, family: string) {
  return withLock(() => {
    const k = key(pool, host, family);
    writeRows(rawRows().filter((r) => `${r[0]}\t${r[1]}` !== k));
  });
}

export function resetPool(pool: string | null) {
  return withLock(() => writeRows(pool ? rawRows().filter((r) => r[0] !== pool) : []));
}

export function ensureStateFile() {
  if (!existsSync(stateFile())) writeFileSync(stateFile(), HEADER);
}
