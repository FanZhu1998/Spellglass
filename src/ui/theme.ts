// Theme runtime: a theme pack owns everything a player sees or hears that is not a spell
// (Section 9.2). This applies its tokens, accent pair and fonts as CSS variables on :root,
// plus the access settings that change the chrome (motion, contrast).

import type { SettingsMap, ThemePack } from '../contracts';

const TOKEN_NAMES = ['night', 'slate', 'vellum', 'ink', 'candle', 'oxblood', 'verdigris', 'ash'];

export function applyTheme(theme: ThemePack | null | undefined, settings: SettingsMap, root: HTMLElement = document.documentElement): void {
  if (theme) {
    for (const name of TOKEN_NAMES) {
      const value = theme.tokens?.[name];
      if (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)) root.style.setProperty(`--${name}`, value);
    }
    const accent = settings['theme.accent'];
    const pair = accent && accent !== 'default' ? theme.accents?.[accent] : undefined;
    if (pair) {
      root.style.setProperty('--candle', pair.candle);
      root.style.setProperty('--oxblood', pair.oxblood);
    } else {
      if (theme.tokens?.candle) root.style.setProperty('--candle', theme.tokens.candle);
      if (theme.tokens?.oxblood) root.style.setProperty('--oxblood', theme.tokens.oxblood);
    }
    const safeFont = (f: unknown) => (typeof f === 'string' && /^[\w\s-]+$/.test(f) ? `'${f}'` : null);
    // A theme may also name the small capitals of labels and the ornate capitals of the wordmark and
    // drop caps; without them those follow the display face (tokens.css). Only fonts the app ships
    // can be drawn (base.css), so a name it lacks falls back.
    const fonts = theme.fonts as { display?: unknown; text?: unknown; label?: unknown; ornate?: unknown } | undefined;
    const display = safeFont(fonts?.display);
    const text = safeFont(fonts?.text);
    const label = safeFont(fonts?.label);
    const ornate = safeFont(fonts?.ornate);
    if (display) root.style.setProperty('--font-display', `${display}, 'Iowan Old Style', Palatino, Georgia, serif`);
    if (text) root.style.setProperty('--font-text', `${text}, 'Iowan Old Style', Georgia, serif`);
    if (label) root.style.setProperty('--font-label', `${label}, ${display ?? "'IM Fell English'"}, Georgia, serif`);
    if (ornate) root.style.setProperty('--font-ornate', `${ornate}, ${display ?? "'IM Fell English'"}, Georgia, serif`);
  }
  const motion = settings['access.reducedMotion'];
  root.dataset.motion = motion === 'on' ? 'reduced' : motion === 'off' ? 'full' : 'system';
  root.dataset.contrast = settings['access.highContrastTrail'] ? 'high' : 'normal';
}

/** A transition's duration under the player's motion choice (Section 10.6): 0 when motion is reduced,
 *  read from the root's data-motion (set by applyTheme) or, for 'system', the system preference. */
export function motionMs(ms: number): number {
  if (typeof document === 'undefined') return ms;
  const m = document.documentElement.dataset.motion;
  if (m === 'reduced') return 0;
  if (m === 'full') return ms;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
}

/** True when motion should be reduced, from the setting or the system preference. */
export function reducedMotion(settings: SettingsMap): boolean {
  const m = settings['access.reducedMotion'];
  if (m === 'on') return true;
  if (m === 'off') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
