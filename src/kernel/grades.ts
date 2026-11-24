// The theme turns quality into a grade (Section 7.7, 9.2).

import type { Grade, ThemePack } from '../contracts';

const DEFAULT_GRADES: { cast: Grade[]; fizzle: Grade[] } = {
  cast: [
    { min: 0.9, label: 'Outstanding' },
    { min: 0.8, label: 'Exceeds Expectations' },
    { min: 0, label: 'Acceptable' },
  ],
  fizzle: [
    { min: 0.6, label: 'Poor' },
    { min: 0.45, label: 'Dreadful' },
    { min: 0, label: 'Troll' },
  ],
};

export function gradeFor(quality: number, kind: 'cast' | 'fizzle', theme?: ThemePack | null): string {
  const list = [...(theme?.grades?.[kind] ?? DEFAULT_GRADES[kind])].sort((a, b) => b.min - a.min);
  const q = Number.isFinite(quality) ? quality : 0;
  return (list.find((g) => q >= g.min) ?? list[list.length - 1])?.label ?? '';
}
