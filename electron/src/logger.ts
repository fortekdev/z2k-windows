import { appendFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { LogEntry, LogSource } from '../../shared/types';
import { data } from './paths';

const MAX_ENTRIES = 3000;
const MAX_FILE = 4 * 1024 * 1024;

class Logger extends EventEmitter {
  private buf: LogEntry[] = [];
  private seq = 0;

  private file(): string {
    return join(data.logs(), 'z2k.log');
  }

  private rotate(file: string) {
    try {
      if (existsSync(file) && statSync(file).size > MAX_FILE) renameSync(file, file + '.1');
    } catch { /* ротация не критична */ }
  }

  write(source: LogSource, level: LogEntry['level'], msg: string) {
    const entry: LogEntry = { id: ++this.seq, ts: Date.now(), source, level, msg };
    this.buf.push(entry);
    if (this.buf.length > MAX_ENTRIES) this.buf.splice(0, this.buf.length - MAX_ENTRIES);
    this.emit('entry', entry);
    try {
      const file = this.file();
      if (this.seq % 200 === 0) this.rotate(file);
      appendFileSync(file, `${new Date(entry.ts).toISOString()} [${source}] ${level.toUpperCase()} ${msg}\n`);
    } catch { /* лог на диск — best effort */ }
  }

  info(source: LogSource, msg: string) { this.write(source, 'info', msg); }
  warn(source: LogSource, msg: string) { this.write(source, 'warn', msg); }
  error(source: LogSource, msg: string) { this.write(source, 'error', msg); }
  debug(source: LogSource, msg: string) { this.write(source, 'debug', msg); }

  tail(source?: LogSource, limit = 500): LogEntry[] {
    const list = source ? this.buf.filter((e) => e.source === source) : this.buf;
    return list.slice(-limit);
  }
}

export const log = new Logger();
