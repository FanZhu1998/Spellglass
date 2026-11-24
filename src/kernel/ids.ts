let counter = 0;

/** Short unique id, e.g. 'cast-lq3x9a-7'. Not secret; only unique within and across sessions. */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${prefix}-${Date.now().toString(36)}${rand}-${counter.toString(36)}`;
}
