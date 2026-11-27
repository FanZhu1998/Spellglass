// Keyboard helpers for the Workshop's own controls (Section 10.6: every control reachable by keyboard).

/** A confirmation that just appeared: bring it into view and move focus to its safe choice (the button
 *  marked data-safe), so Enter never deletes by accident. */
export function reveal(node: HTMLElement) {
  queueMicrotask(() => {
    node.scrollIntoView({ block: 'nearest' });
    node.querySelector<HTMLElement>('[data-safe]')?.focus({ preventScroll: true });
  });
}

/** Arrow keys, Home and End move between the role="radio" buttons of a segmented group and choose the
 *  one they land on (the WAI-ARIA radio group keys). Tab still reaches every button. */
export function radioKeys(node: HTMLElement) {
  const handler = (e: KeyboardEvent) => {
    const radios = [...node.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])')];
    const i = radios.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % radios.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + radios.length) % radios.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = radios.length - 1;
    if (next < 0) return;
    e.preventDefault();
    radios[next].focus();
    radios[next].click();
  };
  node.addEventListener('keydown', handler);
  return {
    destroy() {
      node.removeEventListener('keydown', handler);
    },
  };
}
