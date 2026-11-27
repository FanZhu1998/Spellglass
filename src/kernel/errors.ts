import type { KernelErrorCode } from '../contracts';

export class KernelError extends Error {
  readonly code: KernelErrorCode;
  override readonly cause?: unknown;
  constructor(code: KernelErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
    this.cause = cause;
  }
}

/** Plain {name, message} for errors that cross the bus (DOMException names are kept). */
export function describeError(err: unknown): { name: string; message: string } {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown };
    return { name: typeof e.name === 'string' ? e.name : 'Error', message: typeof e.message === 'string' ? e.message : String(err) };
  }
  return { name: 'Error', message: String(err) };
}
