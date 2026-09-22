/**
 * Money is stored as integer centimes everywhere in this product. The two
 * places that can break that promise are the boundaries: the form that turns
 * dirhams typed by a human into centimes, and the formatter that turns centimes
 * back into something a Moroccan accountant will read.
 *
 * A float defect here is the most expensive bug this codebase could ship -- it
 * is silent, it compounds across a ledger, and it surfaces as a customer
 * dispute rather than a stack trace. These assertions are about exactness, not
 * about how the output looks: the display assertions compare digits only, so
 * they do not break when the bundled ICU data shifts a currency symbol or a
 * narrow no-break space.
 */
import { afterEach, describe, expect, it } from "vitest";
import { formatMoney, percent } from "../../src/shared/formatters.js";
import { setLocale } from "../../src/core/i18n.js";

/** ICU chooses the separators; the digits are the part that must be right. */
const digits = (value) => value.replace(/\D/g, "");

afterEach(() => setLocale("fr"));

describe("centime formatting", () => {
  it("renders exactly two decimals, with no float residue", () => {
    // 815 / 100 is 8.15 in decimal but 8.1500000000000003552713678800501 in
    // IEEE-754. Anything that reaches the DOM through string concatenation
    // instead of Intl would show that.
    expect(digits(formatMoney(815))).toBe("815");
    expect(digits(formatMoney(1))).toBe("001");
    expect(digits(formatMoney(29))).toBe("029");
    expect(digits(formatMoney(100))).toBe("100");
    expect(digits(formatMoney(123456))).toBe("123456");
    expect(digits(formatMoney(999999999))).toBe("999999999");
  });

  it("never emits more than two fractional digits", () => {
    // From 7, because zero takes the short-circuit asserted separately below.
    for (let centimes = 7; centimes <= 2000; centimes += 7) {
      const rendered = formatMoney(centimes);
      expect(rendered).not.toMatch(/[.,]\d{3}/);
      expect(digits(rendered)).toBe(String(centimes).padStart(3, "0"));
    }
  });

  it("stays exact far beyond any amount a Moroccan SME will invoice", () => {
    // 10 000 000 000,00 MAD -- four orders of magnitude past the largest
    // invoice this product plausibly sees.
    const tenBillionDirhams = 1_000_000_000_000;
    expect(digits(formatMoney(tenBillionDirhams))).toBe(String(tenBillionDirhams));
    expect(digits(formatMoney(tenBillionDirhams + 1))).toBe(String(tenBillionDirhams + 1));
  });

  it("documents where double division stops being exact for display", () => {
    // formatMoney divides by 100 before handing the value to Intl. Doubles are
    // spaced further apart than half a centime once the dirham value passes
    // about 2.25e13, so the *display* of an amount above that loses its last
    // centime. The schema's ceiling (Number.MAX_SAFE_INTEGER centimes) is above
    // that line, which is why this is pinned rather than left to be discovered.
    //
    // Stored values are unaffected: they are integers end to end, in the client
    // outbox, in the API schema and in the bigint columns. This is a rendering
    // limit at roughly 22 500 billion dirhams, not a ledger defect.
    const schemaCeiling = 9007199254740991;
    expect(Number.isSafeInteger(schemaCeiling)).toBe(true);
    expect(digits(formatMoney(schemaCeiling))).toBe("9007199254740990");
  });

  it("treats zero as a plain dash-free zero in both locales", () => {
    expect(formatMoney(0)).toBe("0 dh");
    setLocale("ar");
    expect(formatMoney(0)).toBe("0 dh");
  });

  it("formats the same amount in Arabic without losing precision", () => {
    setLocale("ar");
    const arabic = formatMoney(123456);
    // ar-MA renders Western digits, so the same digit assertion holds; what
    // matters is that switching locale cannot change the amount.
    expect(digits(arabic)).toBe("123456");
  });

  it("does not round a sum of centimes", () => {
    // The finance view sums invoice amounts with a plain reduce. That is only
    // safe because every element is an integer.
    const ledger = [199, 2500, 1, 999_99, 33_33, 7];
    const total = ledger.reduce((sum, amount) => sum + amount, 0);
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBe(106_039);
    expect(digits(formatMoney(total))).toBe("106039");

    // The same ledger in dirhams, summed as floats, does not land on the same
    // number -- which is the whole reason the product stores centimes.
    const asFloats = ledger.reduce((sum, amount) => sum + amount / 100, 0);
    expect(asFloats).not.toBe(total / 100);
  });
});

describe("percentages", () => {
  it("rounds half away from zero, and never emits a fraction", () => {
    expect(percent(0)).toBe("0%");
    expect(percent(66.4)).toBe("66%");
    expect(percent(66.5)).toBe("67%");
    expect(percent(99.99)).toBe("100%");
  });
});
