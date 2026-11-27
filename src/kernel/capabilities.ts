// Capabilities, not version checks (Section 9.1 rule 5). A capability is 'name' or 'name@N'.
// Providing 'fx.light@2' meets needs for 'fx.light@1' and 'fx.light@2'; unversioned means @1.

export function parseCapability(cap: string): { name: string; version: number } {
  const at = cap.lastIndexOf('@');
  if (at <= 0) return { name: cap, version: 1 };
  const version = Number(cap.slice(at + 1));
  return { name: cap.slice(0, at), version: Number.isFinite(version) && version > 0 ? Math.floor(version) : 1 };
}

export class CapabilitySet {
  private best = new Map<string, number>();

  add(cap: string): void {
    const { name, version } = parseCapability(cap);
    if ((this.best.get(name) ?? 0) < version) this.best.set(name, version);
  }

  has(cap: string): boolean {
    const { name, version } = parseCapability(cap);
    return (this.best.get(name) ?? 0) >= version;
  }

  /** The needs in `needs` that are not met. */
  unmet(needs: readonly string[] | undefined): string[] {
    return (needs ?? []).filter((n) => !this.has(n));
  }

  list(): string[] {
    return [...this.best.entries()].map(([n, v]) => `${n}@${v}`).sort();
  }

  clear(): void {
    this.best.clear();
  }
}
