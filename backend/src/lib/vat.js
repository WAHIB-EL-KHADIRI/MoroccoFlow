import { AppError } from "./errors.js";

/** Moroccan VAT (TVA) rates in basis points: 0%, 7%, 10%, 14%, 20%. */
export const MOROCCAN_VAT_RATES_BP = Object.freeze([0, 700, 1000, 1400, 2000]);

const QUANTITY_SCALE = 1000n; // line_items.quantity is numeric(14, 3)
const BP_SCALE = 10000n;

const invalid = (message) => new AppError("INVALID_LINE", message, 422);

/** Integer division of non-negative BigInts, rounding half up. */
const divRoundHalfUp = (numerator, denominator) => (numerator * 2n + denominator) / (denominator * 2n);

/** Parse a quantity such as "2", "2.5" or 2.125 into thousandths without floating-point error. */
export const parseQuantityMilli = (quantity) => {
  const text = String(quantity).trim();
  if (!/^\d+(\.\d{1,3})?$/.test(text)) {
    throw invalid("Quantity must be a positive number with at most 3 decimals");
  }
  const [whole, fraction = ""] = text.split(".");
  const milli = BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(3, "0"));
  if (milli <= 0n) {
    throw invalid("Quantity must be greater than zero");
  }

  return milli;
};

/** Net amount of one line in cents: quantity x unit price, rounded half up to the cent. */
export const lineSubtotalCents = ({ quantity, unitPriceCents }) => {
  const price = BigInt(unitPriceCents);
  if (price < 0n) {
    throw invalid("Unit price cannot be negative");
  }

  return divRoundHalfUp(parseQuantityMilli(quantity) * price, QUANTITY_SCALE);
};

/**
 * Totals for a quote or invoice.
 *
 * VAT is computed once per rate on the summed net amount of that rate, not per line, so
 * rounding differences cannot accumulate across many small lines. Every amount is an integer
 * number of cents (BigInt internally) and the result uses plain numbers for JSON.
 *
 * Returns { subtotalCents, taxCents, totalCents, byRate: [{ rateBasisPoints, baseCents, taxCents }] }
 * with byRate sorted by rate. Rates outside MOROCCAN_VAT_RATES_BP are rejected.
 */
export const computeTotals = (lines) => {
  const bases = new Map();
  for (const line of lines) {
    const rate = line.taxRateBasisPoints ?? 0;
    if (!MOROCCAN_VAT_RATES_BP.includes(rate)) {
      throw invalid(`Unsupported VAT rate: ${rate} basis points`);
    }
    bases.set(rate, (bases.get(rate) ?? 0n) + lineSubtotalCents(line));
  }

  let subtotal = 0n;
  let tax = 0n;
  const byRate = [...bases.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rateBasisPoints, base]) => {
      const rateTax = divRoundHalfUp(base * BigInt(rateBasisPoints), BP_SCALE);
      subtotal += base;
      tax += rateTax;

      return { rateBasisPoints, baseCents: Number(base), taxCents: Number(rateTax) };
    });

  const result = {
    subtotalCents: Number(subtotal),
    taxCents: Number(tax),
    totalCents: Number(subtotal + tax),
    byRate,
  };
  if (!Number.isSafeInteger(result.totalCents)) {
    throw invalid("Total is too large");
  }

  return result;
};
