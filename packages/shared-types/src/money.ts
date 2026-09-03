// ============================================
// AgentBridge - Money
// ============================================
// RULE: money is ALWAYS an integer count of minor units (paise for INR).
// Binary floating point must never represent currency: 0.1 + 0.2 !== 0.3,
// and `dailySpent` is a running sum compared against a hard limit.
//
// Every money-carrying field in this codebase is suffixed `Minor` so that a
// float can never be silently assigned to it. Formatting happens only at the
// edges (UI strings, human-readable policy reasons).

/** A whole number of minor currency units. Never a float. */
export type Minor = number;

export const SUPPORTED_CURRENCIES = ['INR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

/** Minor units per major unit, per currency (INR: 100 paise = ₹1). */
const MINOR_PER_MAJOR: Record<Currency, number> = { INR: 100 };

/** Currency symbol used in human-readable reason strings. */
const SYMBOL: Record<Currency, string> = { INR: '₹' };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Asserts a value is a safe, non-negative integer amount of minor units.
 * Throws rather than coercing — a bad amount must never reach the policy engine.
 */
export function assertMinor(value: unknown, field = 'amount'): asserts value is Minor {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MoneyError(`${field} must be an integer number of minor units, got: ${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${field} exceeds the safe integer range`);
  }
  if (value < 0) {
    throw new MoneyError(`${field} must not be negative, got: ${value}`);
  }
}

/** Converts major units (₹299) to minor units (29900). For seeds and config only. */
export function toMinor(major: number, currency: Currency = 'INR'): Minor {
  const factor = MINOR_PER_MAJOR[currency];
  const result = Math.round(major * factor);
  assertMinor(result, 'converted amount');
  return result;
}

/** Formats minor units as a display string: 29900 → "₹299.00". */
export function formatMinor(minor: Minor, currency: Currency = 'INR'): string {
  const factor = MINOR_PER_MAJOR[currency];
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / factor);
  const rest = abs % factor;
  return `${sign}${SYMBOL[currency]}${major.toLocaleString('en-IN')}.${String(rest).padStart(2, '0')}`;
}

/**
 * Multiplies a unit price by a quantity with overflow and integrality checks.
 * This is the ONLY sanctioned way to compute a line total.
 */
export function multiplyMinor(unitMinor: Minor, quantity: number): Minor {
  assertMinor(unitMinor, 'unit price');
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new MoneyError(`quantity must be a positive integer, got: ${String(quantity)}`);
  }
  const total = unitMinor * quantity;
  if (!Number.isSafeInteger(total)) {
    throw new MoneyError('line total exceeds the safe integer range');
  }
  return total;
}
