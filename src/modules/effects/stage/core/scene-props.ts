// 'scene.props' (contracts/scene.ts): what the spell engine targets. Built from each prop's own
// view of itself, so the props half owns labels, tags and state.

import type { PropInfo, SceneProps } from '../../../../contracts';
import type { PropView } from '../types';
import { logger } from '../../../../kernel';

const log = logger('stage');

export function buildSceneProps(props: readonly PropView[], revision: number, aspect: number): SceneProps {
  const out: PropInfo[] = [];
  for (const p of props) {
    try {
      out.push({
        id: p.id,
        label: p.label(),
        x: p.x,
        y: p.y,
        r: p.radius,
        tags: [...p.tags()],
        state: { ...p.state() },
      });
    } catch (err) {
      log.warn(`prop ${p.id} could not describe itself`, err);
    }
  }
  return { revision, aspect, props: out };
}

/** True when the published props differ in anything the engine or shell would notice. */
export function scenePropsDiffer(a: SceneProps | undefined, b: SceneProps): boolean {
  if (!a || a.aspect !== b.aspect || a.props.length !== b.props.length) return true;
  for (let i = 0; i < b.props.length; i++) {
    const p = a.props[i], q = b.props[i];
    if (p.id !== q.id || p.label !== q.label || p.r !== q.r) return true;
    if (Math.abs(p.x - q.x) > 1e-4 || Math.abs(p.y - q.y) > 1e-4) return true;
    if (p.tags.join(',') !== q.tags.join(',')) return true;
    if (JSON.stringify(p.state) !== JSON.stringify(q.state)) return true;
  }
  return false;
}
