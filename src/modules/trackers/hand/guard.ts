// Keeps the hand worker's network traffic on the app's own origin (Section 11.2: "There is no analytics";
// "The content security policy allows connections only to the app's own origin").
//
// Why the worker needs this: @mediapipe/tasks-vision 1.2.3 always starts a usage logger when a task is
// created, which POSTs to https://odml.pa.googleapis.com/v1/log every minute and when the task closes
// (see the package README's privacy notice; it cannot be switched off). On the main thread the app's CSP
// (connect-src 'self', index.html) blocks that. A dedicated worker loaded from a URL does not inherit the
// page's policy, though: it takes its policy from its own HTTP response, and a static host sends none. So
// inside the worker, fetch and XMLHttpRequest refuse any URL that is not same-origin, blob: or data:. The
// logger treats the refusal like a failed request and stops trying. Nothing else in the worker needs
// another origin: the model, the WASM binary and its loader all come from /models/.

interface NetworkScope {
  location: { href: string; origin: string };
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  XMLHttpRequest?: { prototype: { open: (...args: unknown[]) => void } };
}

/** Whether a URL stays on the app's origin (blob: and data: URLs never leave the device). */
export function isLocalUrl(url: string, base: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return false;
  }
  if (u.protocol === 'data:') return true;
  // new URL('blob:https://host/uuid').origin is 'https://host'.
  return u.origin === origin;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/** Install the guard on a worker scope. Returns the URLs refused so far (for tests and diagnostics);
 *  `onRefuse` hears about each one as it happens. */
export function restrictNetwork(scope: NetworkScope, onRefuse?: (url: string) => void): { refused: string[] } {
  const refused: string[] = [];
  const { href, origin } = scope.location;
  const refuse = (url: string) => {
    refused.push(url);
    onRefuse?.(url);
  };
  const nativeFetch = scope.fetch?.bind(scope);
  if (nativeFetch) {
    scope.fetch = (input, init) => {
      const url = urlOf(input);
      if (isLocalUrl(url, href, origin)) return nativeFetch(input, init);
      refuse(url);
      return Promise.reject(new TypeError('Spellglass keeps the hand tracker on this device.'));
    };
  }
  const xhr = scope.XMLHttpRequest?.prototype;
  if (xhr && typeof xhr.open === 'function') {
    const open = xhr.open;
    xhr.open = function (this: unknown, ...args: unknown[]) {
      const url = String(args[1] ?? '');
      if (!isLocalUrl(url, href, origin)) {
        refuse(url);
        throw new TypeError('Spellglass keeps the hand tracker on this device.');
      }
      return open.apply(this, args);
    };
  }
  return { refused };
}
