// Small formatting and error helpers shared by Wand tuning, Keepsakes and the Workshop.
// Plain functions only: no state, no kernel access.

import { describeError } from '../../../kernel';

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' });

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Just now", "4 minutes ago", "Today at 21:04", "Yesterday at 21:04", "12 November at 21:04". */
export function timeAgo(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return capitalize(relative.format(-minutes, 'minute'));
  const then = new Date(at);
  const today = new Date(now);
  if (sameDay(then, today)) return `Today at ${clock.format(then)}`;
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(then, yesterday)) return `Yesterday at ${clock.format(then)}`;
  return `${day.format(then)} at ${clock.format(then)}`;
}

/** "880 bytes", "14 KB", "1.2 MB", "2.1 GB". */
export function formatBytes(n: number | undefined | null): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 'unknown';
  if (n < 1024) return `${Math.round(n)} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** An exposure time in the Image Capture unit of 100 µs, for people: "8.3 ms (1/120 s)". */
export function exposureText(time: number | undefined | null): string {
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return 'unknown';
  const ms = time / 10;
  const msText = ms < 10 ? ms.toFixed(1) : String(Math.round(ms));
  const per = Math.round(1000 / ms);
  return per >= 2 ? `${msText} ms (1/${per} s)` : `${msText} ms`;
}

/** The sentence a rejection carries (KernelError, {name, message} or anything else). */
export function errorText(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  const { message } = describeError(err);
  const text = (message || '').trim();
  if (!text || text === '[object Object]') return fallback;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** KernelError code of a rejection, if it has one. */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** "2026-11-21", for file names. */
export function dateStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A JSON text as a file the share module can hand over. */
export function jsonBlob(text: string): Blob {
  return new Blob([text], { type: 'application/json' });
}

/** Read a dropped or chosen file as text. */
export function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

export function percent(v: number | undefined | null): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–';
}

export function round(v: number | undefined | null, digits = 0): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  return digits > 0 ? v.toFixed(digits) : String(Math.round(v));
}
