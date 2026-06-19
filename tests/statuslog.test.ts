import { describe, it, expect } from 'vitest';
import { StatusLog } from '../src/statuslog';

describe('StatusLog — recording & dedup', () => {
  it('starts empty and returns undefined for any time', () => {
    const log = new StatusLog();
    expect(log.length).toBe(0);
    expect(log.statusAt(1000)).toBeUndefined();
  });

  it('records the first status', () => {
    const log = new StatusLog();
    log.record(100, 'active');
    expect(log.length).toBe(1);
    expect(log.statusAt(100)).toBe('active');
  });

  it('does not record consecutive identical statuses', () => {
    const log = new StatusLog();
    log.record(100, 'active');
    log.record(150, 'active');
    log.record(200, 'active');
    expect(log.length).toBe(1);
  });

  it('records only genuine transitions', () => {
    const log = new StatusLog();
    log.record(100, 'active');
    log.record(200, 'stuck');
    log.record(250, 'stuck');
    log.record(300, 'active');
    expect(log.length).toBe(3); // active, stuck, active
  });

  it('enforces the hard cap by dropping oldest transitions', () => {
    const log = new StatusLog(3);
    const statuses = ['active', 'stuck', 'active', 'hallucinating', 'active'] as const;
    statuses.forEach((s, i) => log.record(i * 100, s));
    expect(log.length).toBe(3);
    // The most recent three transitions are retained.
    expect(log.statusAt(500)).toBe('active');
  });
});

describe('StatusLog — statusAt (binary search)', () => {
  const make = () => {
    const log = new StatusLog();
    log.record(100, 'active');
    log.record(300, 'stuck');
    log.record(500, 'hallucinating');
    log.record(700, 'active');
    return log;
  };

  it('returns undefined before the first transition', () => {
    expect(make().statusAt(50)).toBeUndefined();
  });

  it('returns the exact status at a transition timestamp', () => {
    const log = make();
    expect(log.statusAt(100)).toBe('active');
    expect(log.statusAt(300)).toBe('stuck');
    expect(log.statusAt(500)).toBe('hallucinating');
    expect(log.statusAt(700)).toBe('active');
  });

  it('returns the active status between transitions', () => {
    const log = make();
    expect(log.statusAt(200)).toBe('active');
    expect(log.statusAt(400)).toBe('stuck');
    expect(log.statusAt(600)).toBe('hallucinating');
    expect(log.statusAt(99999)).toBe('active');
  });

  it('handles a single transition', () => {
    const log = new StatusLog();
    log.record(100, 'thinking');
    expect(log.statusAt(99)).toBeUndefined();
    expect(log.statusAt(100)).toBe('thinking');
    expect(log.statusAt(100000)).toBe('thinking');
  });
});

describe('StatusLog — eviction', () => {
  it('drops stale transitions but preserves the one in effect', () => {
    const log = new StatusLog();
    log.record(100, 'active');
    log.record(300, 'stuck');
    log.record(500, 'active');
    log.evictOlderThan(400); // 'stuck' (t=300) is active at 400, must survive
    // Querying at/after 400 must still work.
    expect(log.statusAt(400)).toBe('stuck');
    expect(log.statusAt(500)).toBe('active');
  });

  it('is a no-op when nothing is stale', () => {
    const log = new StatusLog();
    log.record(100, 'active');
    log.record(300, 'stuck');
    log.evictOlderThan(50);
    expect(log.length).toBe(2);
  });
});

describe('StatusLog — transitionsInRange', () => {
  it('includes the status active at the window start plus in-range changes', () => {
    const log = new StatusLog();
    log.record(0, 'active');
    log.record(100, 'stuck');
    log.record(200, 'active');
    log.record(300, 'hallucinating');
    const range = log.transitionsInRange(150, 250);
    // active@150 (in effect at start) + active@200
    expect(range[0]).toEqual({ t: 150, status: 'stuck' });
    expect(range.some((x) => x.t === 200 && x.status === 'active')).toBe(true);
    expect(range.every((x) => x.t <= 250)).toBe(true);
  });

  it('returns empty for an empty log', () => {
    expect(new StatusLog().transitionsInRange(0, 100)).toEqual([]);
  });
});
