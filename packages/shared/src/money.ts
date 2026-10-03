import { Decimal } from 'decimal.js';

/**
 * Money helpers. Amounts are always handled as decimal strings, never JS numbers.
 *
 * Rounding policy is PENDING accountant approval (SUP-008 / docs/03). Callers must
 * pass the mode explicitly; there is no silent default.
 */
export type RoundingMode = 'HALF_UP' | 'HALF_EVEN';

const MODES: Record<RoundingMode, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
};

const AMOUNT_RE = /^-?\d{1,16}(\.\d{1,2})?$/;
const RATE_RE = /^\d{1,12}(\.\d{1,6})?$/;

export function parseAmount(value: string): Decimal {
  if (!AMOUNT_RE.test(value)) throw new Error(`Invalid amount: ${value}`);
  return new Decimal(value);
}

export function parseRate(value: string): Decimal {
  if (!RATE_RE.test(value)) throw new Error(`Invalid rate: ${value}`);
  const rate = new Decimal(value);
  if (rate.lte(0)) throw new Error(`Rate must be positive: ${value}`);
  return rate;
}

/** Convert a transaction-currency amount to GTQ at `rate`, rounded to 2 decimals. */
export function toFunctional(amount: string, rate: string, mode: RoundingMode): string {
  return parseAmount(amount)
    .times(parseRate(rate))
    .toDecimalPlaces(2, MODES[mode])
    .toFixed(2);
}

export function sum(values: readonly string[]): string {
  return values.reduce((acc, v) => acc.plus(parseAmount(v)), new Decimal(0)).toFixed(2);
}
