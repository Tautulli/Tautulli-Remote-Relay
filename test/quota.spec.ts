import { describe, expect, it } from 'vitest';
import { buildDecision, nextUtcMidnightMs, parseDailyLimit, utcDayKey } from '../src/quota';

describe('parseDailyLimit', () => {
  it('treats unset, zero, negative, and junk values as monitor mode', () => {
    expect(parseDailyLimit(undefined)).toBeNull();
    expect(parseDailyLimit('0')).toBeNull();
    expect(parseDailyLimit('-5')).toBeNull();
    expect(parseDailyLimit('not-a-number')).toBeNull();
    expect(parseDailyLimit('')).toBeNull();
  });

  it('parses a positive integer as an enforced cap', () => {
    expect(parseDailyLimit('100')).toBe(100);
    expect(parseDailyLimit('1')).toBe(1);
  });
});

describe('utcDayKey / nextUtcMidnightMs', () => {
  it('keys days in UTC', () => {
    const ts = Date.UTC(2026, 6, 28, 23, 59, 59);
    expect(utcDayKey(ts)).toBe('2026-07-28');
    expect(utcDayKey(ts + 1000)).toBe('2026-07-29');
  });

  it('computes the next UTC midnight', () => {
    const ts = Date.UTC(2026, 6, 28, 15, 30, 0);
    expect(nextUtcMidnightMs(ts)).toBe(Date.UTC(2026, 6, 29, 0, 0, 0));
    expect(nextUtcMidnightMs(Date.UTC(2026, 11, 31, 12, 0, 0))).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
  });
});

describe('buildDecision', () => {
  const now = Date.UTC(2026, 6, 28, 12, 0, 0);

  it('reports monitor mode with null maximum/remaining', () => {
    const decision = buildDecision(7, null, true, now);
    expect(decision).toMatchObject({
      allowed: true,
      enforced: false,
      maximum: null,
      used: 7,
      remaining: null,
    });
    expect(decision.resetsAt).toBe(new Date(Date.UTC(2026, 6, 29)).toISOString());
  });

  it('reports remaining under an enforced cap and clamps at zero', () => {
    expect(buildDecision(30, 100, true, now)).toMatchObject({ enforced: true, maximum: 100, remaining: 70 });
    expect(buildDecision(100, 100, false, now)).toMatchObject({ allowed: false, remaining: 0 });
    expect(buildDecision(250, 100, false, now).remaining).toBe(0);
  });
});
