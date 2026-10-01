'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function Card({ title, subtitle, actions, children, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-line bg-panel', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export function Button({ variant = 'secondary', busy, icon, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; icon?: ReactNode }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-accent text-[#04121f] hover:brightness-110',
    secondary: 'bg-panel-2 text-fg border border-line hover:border-[#3a4658]',
    danger: 'bg-bad/15 text-bad border border-bad/30 hover:bg-bad/25',
    ghost: 'text-muted hover:text-fg hover:bg-panel-2',
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={cx('inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50', styles[variant], className)}
    >
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, disabled, label, hint }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode; hint?: ReactNode }) {
  return (
    <label className={cx('flex items-start justify-between gap-4', disabled ? 'opacity-50' : 'cursor-pointer')}>
      {(label || hint) && (
        <span className="min-w-0">
          {label && <span className="block text-[14px]">{label}</span>}
          {hint && <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{hint}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-accent' : 'bg-[#2a3444]')}
      >
        <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </label>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'ok' | 'warn' | 'bad' | 'neutral' | 'accent'; children: ReactNode }) {
  const tones = {
    ok: 'bg-ok/15 text-ok',
    warn: 'bg-warn/15 text-warn',
    bad: 'bg-bad/15 text-bad',
    neutral: 'bg-panel-2 text-muted',
    accent: 'bg-accent/15 text-accent',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium', tones[tone])}>{children}</span>;
}

export function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'neutral' }) {
  const c = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', neutral: 'bg-muted' }[tone];
  return <span className={cx('inline-block size-2.5 rounded-full', c, tone === 'ok' && 'shadow-[0_0_10px] shadow-ok/60')} />;
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx('h-9 rounded-lg border border-line bg-bg px-3 text-[13.5px] outline-none placeholder:text-muted/70 focus:border-accent', props.className)} />;
}

export function Select({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cx('h-9 rounded-lg border border-line bg-bg px-2.5 text-[13.5px] outline-none focus:border-accent', className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="selectable mt-3 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad">{error}</div>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-bg/50 px-4 py-3">
      <div className="text-[12px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-[18px] font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[12px] text-muted">{hint}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-panel p-1">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} className={cx('rounded-md px-3.5 py-1.5 text-[13px] font-medium transition', value === t.id ? 'bg-panel-2 text-fg' : 'text-muted hover:text-fg')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-[13.5px] leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}
