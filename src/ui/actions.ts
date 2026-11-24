// Svelte actions shared by screens.

/** Place an element created outside Svelte (the stage's mirror) inside this node. */
export function hostElement(node: HTMLElement, el: HTMLElement) {
  node.appendChild(el);
  return {
    update(next: HTMLElement) {
      if (next !== el) {
        el.remove();
        el = next;
        node.appendChild(el);
      }
    },
    destroy() {
      // Keep the element alive: the stage owns it and may be shown again.
      if (el.parentNode === node) node.removeChild(el);
    },
  };
}

/** Call `fn` when Escape is pressed while this node is mounted. */
export function onEscape(node: HTMLElement, fn: () => void) {
  const handler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      fn();
    }
  };
  window.addEventListener('keydown', handler);
  return {
    update(next: () => void) {
      fn = next;
    },
    destroy() {
      window.removeEventListener('keydown', handler);
    },
  };
}

/** Move focus into the node when it mounts (dialogs and drawers), and back when it unmounts, unless
 *  something else has taken it meanwhile (restoreFocus). */
export function focusOnMount(node: HTMLElement) {
  const previous = document.activeElement;
  queueMicrotask(() => {
    const target = node.querySelector<HTMLElement>('[autofocus], [data-autofocus], h2, button, a, input, select') ?? node;
    if (!target.hasAttribute('tabindex') && target.tagName === 'H2') target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  });
  return {
    destroy() {
      restoreFocus(previous);
    },
  };
}

// ------------------------------------------------------------------ focus, for players on the keyboard
// or a screen reader (access, Section 10.6)

/** Where focus goes when the control that had it is gone: the Mirror bar's first button. */
export const FOCUS_HOME = '[data-focus-home]';

const TABBABLE = 'a[href], area[href], button, input, select, textarea, iframe, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]';

/** Drawn at all: not inside display: none (or visibility: hidden, where the browser can tell). */
function rendered(el: HTMLElement): boolean {
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  for (let e: HTMLElement | null = el; e; e = e.parentElement) if (getComputedStyle(e).display === 'none') return false;
  return true;
}

/** The elements inside `root` that Tab stops at, in document order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  const stops = [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => el.tabIndex >= 0 && !el.matches(':disabled') && !(el instanceof HTMLInputElement && el.type === 'hidden') && !el.closest('[inert]') && rendered(el),
  );
  // Tab stops at one radio of a named group: the checked one, else the first.
  const radio = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'radio' && el.name !== '';
  return stops.filter((el) => {
    if (!radio(el)) return true;
    const group = stops.filter((o): o is HTMLInputElement => radio(o) && o.name === el.name && o.form === el.form);
    return el === (group.find((o) => o.checked) ?? group[0]);
  });
}

/** b comes after a in document order (a descendant comes after its ancestor). */
const after = (a: Node, b: Node) => a !== b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/**
 * Keep Tab and Shift+Tab inside a modal dialog: past its last stop focus goes round to its first, and
 * back. The key is caught on the dialog itself, so only while focus is inside it: a drawer folded down
 * to its bar is inert, never sees the key and so never pulls focus back into itself.
 */
export function trapFocus(node: HTMLElement) {
  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    const stops = tabbables(node);
    const at = document.activeElement;
    if (!stops.length) {
      e.preventDefault();
      return;
    }
    // Focus can rest on something that is no stop itself (the title the dialog focuses on opening), so
    // the test is whether any stop lies beyond it, not whether it is the first or last stop.
    if (e.shiftKey) {
      if (!at || !stops.some((el) => after(el, at))) {
        e.preventDefault();
        stops[stops.length - 1].focus();
      }
    } else if (!at || !stops.some((el) => after(at, el))) {
      e.preventDefault();
      stops[0].focus();
    }
  };
  node.addEventListener('keydown', handler);
  return {
    destroy() {
      node.removeEventListener('keydown', handler);
    },
  };
}

/** Focus has fallen to the page: the focused element was removed, or nothing had focus. */
function focusLost(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
}

/** Focus `el` when focus has fallen to the page because the control that had it went away (a
 *  confirmation answered, a card removed, a button disabled while it works), and never when the player
 *  has moved focus elsewhere meanwhile. */
export function focusIfLost(el: Element | null | undefined): void {
  if (el instanceof HTMLElement && el.isConnected && focusLost()) el.focus();
}

function focusBack(previous: Element | null): void {
  if (previous instanceof HTMLElement && previous !== document.body && previous !== document.documentElement && previous.isConnected) {
    previous.focus({ preventScroll: true });
  }
}

/**
 * Give focus back when a dialog, drawer or page goes away: to `previous`, the element that had it
 * before, or when that is gone (Practice's "Back to book", the first run's page) to the Mirror bar's
 * first button. Only when focus has fallen to the page: focus anywhere else was put there on purpose,
 * such as the title of a screen opened from this one, and pulling it back would strand it behind that
 * screen. Svelte removes a closing screen before its teardown runs, so focus that was in it has fallen
 * by then.
 */
export function restoreFocus(previous: Element | null): void {
  if (!focusLost()) return;
  focusBack(previous);
  if (!focusLost()) return;
  // The next screen comes in the same update as this one goes, and the room behind a dialog stops
  // being inert in it too: try again once that update is done.
  queueMicrotask(() => {
    if (!focusLost()) return;
    focusBack(previous);
    if (focusLost()) document.querySelector<HTMLElement>(FOCUS_HOME)?.focus({ preventScroll: true });
  });
}
