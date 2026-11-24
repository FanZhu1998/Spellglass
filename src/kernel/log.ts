// Small logger. Deprecations warn once per key (Section 9.1 rule 7).

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let threshold: Level = 'info';
const warnedOnce = new Set<string>();

export function setLogLevel(level: Level): void {
  threshold = level;
}

function out(level: Level, scope: string, args: unknown[]): void {
  if (order[level] < order[threshold]) return;
  const fn = level === 'debug' ? console.debug : level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
  fn(`[${scope}]`, ...args);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Warn once per key, e.g. for a deprecated field. */
  once(key: string, ...args: unknown[]): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (...a) => out('debug', scope, a),
    info: (...a) => out('info', scope, a),
    warn: (...a) => out('warn', scope, a),
    error: (...a) => out('error', scope, a),
    once: (key, ...a) => {
      if (warnedOnce.has(key)) return;
      warnedOnce.add(key);
      out('warn', scope, a);
    },
  };
}
