// Minimal semantic-version ranges, enough for module contract ranges ('^1.0') and pack engine
// ranges ('>=1.0 <2.0'). Supports: exact '1.2.3', partial '1.2', '1.x', '*', caret '^1.2',
// tilde '~1.2', comparators '>=', '>', '<=', '<', '=', space-separated (AND) and '||' (OR).

export type Version = [number, number, number];

export function parseVersion(v: string): Version | null {
  const m = /^\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:[-+].*)?\s*$/.exec(v);
  if (!m) return null;
  const n = (s: string | undefined) => (s === undefined || s === 'x' || s === '*' ? 0 : Number(s));
  return [Number(m[1]), n(m[2]), n(m[3])];
}

export function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

type Test = (v: Version) => boolean;

function partialParts(v: string): (number | null)[] {
  return v.replace(/^v/, '').split('.').map((p) => (p === 'x' || p === '*' || p === '' ? null : Number(p)));
}

function comparator(token: string): Test | null {
  const t = token.trim();
  if (!t || t === '*' || t === 'x') return () => true;
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(t);
  if (!m) return null;
  const op = m[1] ?? '';
  const base = parseVersion(m[2]);
  if (!base) return null;
  const parts = partialParts(m[2]);
  switch (op) {
    case '^': {
      // ^1.2.3 := >=1.2.3 <2.0.0 ; ^0.2.3 := >=0.2.3 <0.3.0
      const upper: Version = base[0] > 0 ? [base[0] + 1, 0, 0] : base[1] > 0 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
      return (v) => compare(v, base) >= 0 && compare(v, upper) < 0;
    }
    case '~': {
      const upper: Version = [base[0], base[1] + 1, 0];
      return (v) => compare(v, base) >= 0 && compare(v, upper) < 0;
    }
    case '>=': return (v) => compare(v, base) >= 0;
    case '>': return (v) => compare(v, base) > 0;
    case '<=': return (v) => compare(v, base) <= 0;
    case '<': return (v) => compare(v, base) < 0;
    default: {
      // '=' or bare: partial versions match any value in the missing places (1.x, 1.2)
      return (v) => parts.every((p, i) => p === null || p === undefined || v[i] === p);
    }
  }
}

/** True when `version` satisfies `range`. Unparseable ranges never match. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  return range.split('||').some((alt) => {
    const tokens = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    const tests = tokens.map(comparator);
    if (tests.some((t) => t === null)) return false;
    return (tests as Test[]).every((t) => t(v));
  });
}
