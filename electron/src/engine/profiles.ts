// Профили nfqws2/winws2, сгенерированные настоящим генератором z2k (resources/strategies/z2k-profiles.txt).
// Здесь — разбор, адресация пулов и стратегий, подмена своих строк, выделение одной стратегии для теста.
import { readFileSync } from 'node:fs';
import type { PoolId } from '../../../shared/types';

export type ProfileName = 'rkn_template' | PoolId | 'wa_noise' | 'unknown';

export interface Profile {
  name: ProfileName;
  tokens: string[];
}

const TEMPLATE_NAME = 'z2k_rkn_arsenal';

// Токены, задающие «к какому трафику» относится профиль. Остальное — «что делать».
const SCOPE_PREFIXES = ['--filter-', '--hostlist', '--ipset', '--name='];

export function isScopeToken(t: string): boolean {
  return SCOPE_PREFIXES.some((p) => t.startsWith(p));
}

export function parseProfiles(text: string): Profile[] {
  const body = text.replace(/^\s*NFQWS2_OPT="/, '').replace(/"\s*$/, '');
  const tokens = body.split(/\s+/).filter(Boolean);
  const groups: string[][] = [[]];
  for (const t of tokens) {
    if (t === '--new') groups.push([]);
    else groups[groups.length - 1].push(t);
  }
  return groups.filter((g) => g.length).map((g) => ({ name: detectName(g), tokens: g }));
}

function detectName(tokens: string[]): ProfileName {
  if (tokens.some((t) => t === `--template=${TEMPLATE_NAME}`)) return 'rkn_template';
  const circ = tokens.find((t) => t.startsWith('--lua-desync=circular'));
  const key = circ?.match(/:key=([a-z_0-9]+)/)?.[1];
  if (key) return key as PoolId;
  if (tokens.includes('--filter-tcp=5222')) return 'wa_noise';
  return 'unknown';
}

export function loadProfiles(file: string): Profile[] {
  return parseProfiles(readFileSync(file, 'utf8'));
}

export function strategyOf(token: string): number | null {
  if (!token.startsWith('--lua-desync=')) return null;
  const m = token.match(/:strategy=(\d+)(?::|$)/);
  return m ? Number(m[1]) : null;
}

// Токены, в которых лежат стратегии пула (для rkn_tcp — в шаблоне)
function arsenalOf(profiles: Profile[], pool: PoolId): string[] {
  if (pool === 'rkn_tcp') return profiles.find((p) => p.name === 'rkn_template')?.tokens ?? [];
  return profiles.find((p) => p.name === pool)?.tokens ?? [];
}

export function strategyNumbers(profiles: Profile[], pool: PoolId): number[] {
  const set = new Set<number>();
  for (const t of arsenalOf(profiles, pool)) {
    const n = strategyOf(t);
    if (n !== null) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

export function strategyLines(profiles: Profile[], pool: PoolId, n: number): string[] {
  return arsenalOf(profiles, pool)
    .filter((t) => strategyOf(t) === n)
    .map((t) => t.replace(/:strategy=\d+/, ''));
}

export function circularLine(profiles: Profile[], pool: PoolId): string | null {
  return profiles.find((p) => p.name === pool)?.tokens.find((t) => t.startsWith('--lua-desync=circular')) ?? null;
}

/**
 * Профиль, исполняющий ровно одну стратегию пула без ротации — для автоподбора.
 * Без circular каждый --lua-desync исполняется на каждом пакете, поэтому оставляем только инстансы стратегии N.
 * scope — фильтры/списки, которыми ограничиваем проверочный трафик.
 */
export function singleStrategyProfile(profiles: Profile[], pool: PoolId, n: number, scope: string[]): string[] | null {
  const own = profiles.find((p) => p.name === pool);
  if (!own) return null;
  const filters = own.tokens.filter((t) => t.startsWith('--filter-'));
  let body: string[];
  if (pool === 'rkn_tcp') {
    body = arsenalOf(profiles, pool).filter((t) => !t.startsWith('--template'));
  } else {
    body = own.tokens.filter((t) => !isScopeToken(t));
  }
  body = body
    .filter((t) => !t.startsWith('--lua-desync=circular') && !t.startsWith('--import='))
    .filter((t) => {
      const s = strategyOf(t);
      return !t.startsWith('--lua-desync=') || s === n || s === null;
    })
    .map((t) => t.replace(/:strategy=\d+/, ''));
  if (!body.some((t) => t.startsWith('--lua-desync='))) return null;
  return [...filters, ...scope, ...body];
}

/**
 * Своя строка для пула: заменяет «что делать» целиком (как в z2k — вместе с circular, если он в ней есть),
 * фильтры и списки пула сохраняются.
 */
export function applyCustom(profiles: Profile[], pool: PoolId, customTokens: string[]): Profile[] {
  return profiles
    .filter((p) => !(pool === 'rkn_tcp' && p.name === 'rkn_template'))
    .map((p) => {
      if (p.name !== pool) return p;
      const hasOwnFilters = customTokens.some((t) => t.startsWith('--filter-'));
      const scope = p.tokens.filter((t) => isScopeToken(t) && !(hasOwnFilters && t.startsWith('--filter-')));
      return { ...p, tokens: [...scope, ...customTokens] };
    });
}

/** Разбор своей строки: многострочно, комментарии через #, префикс nfqws2/winws2 допускается */
export function parseCustomStrategy(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .join(' ')
    .split(/\s+/)
    .filter((t) => t && !/^(nfqws2|winws2(\.exe)?)$/i.test(t));
}

export function mapTokens(profiles: Profile[], fn: (t: string, p: Profile) => string | null): Profile[] {
  return profiles.map((p) => ({ ...p, tokens: p.tokens.map((t) => fn(t, p)).filter((t): t is string => t !== null) }));
}
