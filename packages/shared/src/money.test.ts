import { describe, expect, it } from 'vitest';
import { parseAmount, parseRate, sum, toFunctional } from './money.ts';

// Expected values below were computed by hand, not by the implementation.
describe('money', () => {
  it('converts USD to GTQ with explicit rounding', () => {
    expect(toFunctional('100.00', '7.700000', 'HALF_UP')).toBe('770.00');
    // 33.33 × 7.712345 = 257.05445885 → 257.05
    expect(toFunctional('33.33', '7.712345', 'HALF_UP')).toBe('257.05');
  });

  it('distinguishes half-up from half-even at the midpoint', () => {
    // 0.05 × 0.5 = 0.025 → HALF_UP 0.03, HALF_EVEN 0.02
    expect(toFunctional('0.05', '0.5', 'HALF_UP')).toBe('0.03');
    expect(toFunctional('0.05', '0.5', 'HALF_EVEN')).toBe('0.02');
  });

  it('sums without floating-point error', () => {
    expect(sum(['0.10', '0.20'])).toBe('0.30');
    expect(sum(['1000000000000.01', '0.02'])).toBe('1000000000000.03');
  });

  it('rejects malformed input', () => {
    expect(() => parseAmount('1.234')).toThrow();
    expect(() => parseAmount('1e3')).toThrow();
    expect(() => parseRate('0')).toThrow();
    expect(() => parseRate('-7.7')).toThrow();
  });
});
