import { describe, expect, it } from 'vitest';
import { formatMoney } from './format.ts';

describe('formatMoney', () => {
  it('groups thousands without floating-point conversion', () => {
    expect(formatMoney('1234567.89')).toBe('Q 1,234,567.89');
    expect(formatMoney('9999999999999999.99')).toBe('Q 9,999,999,999,999,999.99');
    expect(formatMoney('0.5')).toBe('Q 0.50');
    expect(formatMoney('100', 'USD')).toBe('US$ 100.00');
    expect(formatMoney('-20.00')).toBe('-Q 20.00');
  });
});
