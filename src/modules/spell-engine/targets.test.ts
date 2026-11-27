import { describe, expect, it } from 'vitest';
import type { SceneProps } from '../../contracts';
import { PROP_TAGS } from '../../contracts';
import { effectScaleOf, pickTarget, pickVariant, startingProps } from './targets';
import { seedSpell } from './test-support';

describe('pickTarget (Section 7.8)', () => {
  const shelf = startingProps(16 / 9);

  it('starts from the shelf in PROP_START', () => {
    expect(shelf.props.map((p) => p.id)).toEqual(['candle', 'feather', 'box', 'teacup', 'plant', 'dummy']);
    expect(shelf.props.find((p) => p.id === 'box')!.tags).toContain(PROP_TAGS.lockable);
  });

  it('picks the only prop carrying the tag, wherever the stroke ended', () => {
    expect(pickTarget(seedSpell('alohomora').targets, { x: 0.9, y: 0.2 }, shelf)).toBe('box');
    expect(pickTarget(seedSpell('stupefy').targets, { x: 0.1, y: 0.9 }, shelf)).toBe('dummy');
  });

  it('picks the nearest of several', () => {
    expect(pickTarget(seedSpell('accio').targets, { x: 0.58, y: 0.8 }, shelf)).toBe('teacup');
    expect(pickTarget(seedSpell('accio').targets, { x: 0.1, y: 0.5 }, shelf)).toBe('candle');
  });

  it('compares distances isotropically', () => {
    const scene: SceneProps = {
      revision: 1,
      aspect: 16 / 9,
      props: [
        { id: 'a', label: 'a', x: 0.6, y: 0.5, r: 0.05, tags: [PROP_TAGS.any], state: {} },
        { id: 'b', label: 'b', x: 0.5, y: 0.62, r: 0.05, tags: [PROP_TAGS.any], state: {} },
      ],
    };
    // Per axis, a is 0.10 away and b 0.12; on screen a is 0.178 heights away and b 0.12.
    expect(pickTarget([PROP_TAGS.any], { x: 0.5, y: 0.5 }, scene)).toBe('b');
  });

  it('tries the targets in order: the first tag any prop has wins', () => {
    const lit = startingProps();
    const candle = lit.props.find((p) => p.id === 'candle')!;
    candle.tags = candle.tags.filter((t) => t !== PROP_TAGS.flammable).concat(PROP_TAGS.burning);
    // Aguamenti: ['prop.burning', 'prop.any'] — the burning candle, though the aim is at the dummy.
    expect(pickTarget(seedSpell('aguamenti').targets, { x: 0.88, y: 0.8 }, lit)).toBe('candle');
    // Nothing burning: the nearest prop of any kind.
    expect(pickTarget(seedSpell('aguamenti').targets, { x: 0.88, y: 0.8 }, shelf)).toBe('dummy');
  });

  it("matches every prop for 'prop.any' and returns nothing when no prop matches", () => {
    const untagged: SceneProps = { revision: 1, aspect: 1, props: [{ id: 'x', label: 'x', x: 0.5, y: 0.5, r: 0.1, tags: [], state: {} }] };
    expect(pickTarget([PROP_TAGS.any], { x: 0, y: 0 }, untagged)).toBe('x');
    expect(pickTarget(['prop.nothing'], { x: 0.5, y: 0.5 }, shelf)).toBeUndefined();
    expect(pickTarget(undefined, { x: 0.5, y: 0.5 }, shelf)).toBeUndefined();
  });
});

describe('pickVariant', () => {
  const lumos = seedSpell('lumos').variants;

  it('applies Lumos Maxima at power 0.8 and above', () => {
    expect(pickVariant(lumos, 0.8, 0.5)?.label).toBe('Lumos Maxima');
    expect(effectScaleOf(pickVariant(lumos, 0.95, 0.5))).toBe(1.6);
    expect(pickVariant(lumos, 0.79, 1)).toBeUndefined();
    expect(effectScaleOf(undefined)).toBe(1);
  });

  it('takes the first variant whose bounds all match', () => {
    const variants = [
      { when: { power_max: 0.2 }, label: 'Faint', effect_scale: 0.6 },
      { when: { power_min: 0.5, quality_min: 0.9 }, label: 'Grand', effect_scale: 1.4 },
      { when: { power_min: 0.5 }, label: 'Strong' },
    ];
    expect(pickVariant(variants, 0.1, 1)?.label).toBe('Faint');
    expect(pickVariant(variants, 0.6, 0.95)?.label).toBe('Grand');
    expect(pickVariant(variants, 0.6, 0.5)?.label).toBe('Strong');
    expect(effectScaleOf(pickVariant(variants, 0.6, 0.5))).toBe(1);
    expect(pickVariant(variants, 0.3, 1)).toBeUndefined();
  });
});
