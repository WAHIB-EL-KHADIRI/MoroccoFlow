import { describe, expect, it } from "vitest";
import {
  MOROCCAN_VAT_RATES_BP,
  computeTotals,
  lineSubtotalCents,
  parseQuantityMilli,
} from "../src/lib/vat.js";

const codeOf = (fn) => {
  try {
    fn();
    return "ok";
  } catch (error) {
    return error.code;
  }
};

describe("moroccan VAT rates", () => {
  it("lists exactly the five statutory rates", () => {
    expect([...MOROCCAN_VAT_RATES_BP]).toEqual([0, 700, 1000, 1400, 2000]);
  });
});

describe("parseQuantityMilli", () => {
  it("parses without floating point error", () => {
    expect(parseQuantityMilli("2")).toBe(2000n);
    expect(parseQuantityMilli(2.5)).toBe(2500n);
    expect(parseQuantityMilli("0.001")).toBe(1n);
    expect(parseQuantityMilli("1.125")).toBe(1125n);
  });

  it("rejects zero, negatives, extra decimals and non-numbers", () => {
    for (const bad of ["0", "-1", "1.2345", "abc", "", "1e3", " "]) {
      expect(codeOf(() => parseQuantityMilli(bad))).toBe("INVALID_LINE");
    }
  });
});

describe("lineSubtotalCents", () => {
  it("multiplies quantity by unit price", () => {
    expect(lineSubtotalCents({ quantity: "3", unitPriceCents: 1000 })).toBe(3000n);
    expect(lineSubtotalCents({ quantity: "2.5", unitPriceCents: 1000 })).toBe(2500n);
  });

  it("rounds half up to the cent", () => {
    // 0.5 x 1 cent = 0.5 cent -> 1 ; 0.4 x 1 cent = 0.4 cent -> 0
    expect(lineSubtotalCents({ quantity: "0.5", unitPriceCents: 1 })).toBe(1n);
    expect(lineSubtotalCents({ quantity: "0.4", unitPriceCents: 1 })).toBe(0n);
  });

  it("rejects a negative price", () => {
    expect(codeOf(() => lineSubtotalCents({ quantity: "1", unitPriceCents: -1 }))).toBe(
      "INVALID_LINE",
    );
  });
});

describe("computeTotals", () => {
  it("computes 20% VAT on a simple line", () => {
    const t = computeTotals([{ quantity: "1", unitPriceCents: 100000, taxRateBasisPoints: 2000 }]);

    expect(t).toEqual({
      subtotalCents: 100000,
      taxCents: 20000,
      totalCents: 120000,
      byRate: [{ rateBasisPoints: 2000, baseCents: 100000, taxCents: 20000 }],
    });
  });

  it("breaks totals down per rate, sorted by rate", () => {
    const t = computeTotals([
      { quantity: "1", unitPriceCents: 10000, taxRateBasisPoints: 2000 },
      { quantity: "2", unitPriceCents: 5000, taxRateBasisPoints: 1000 },
      { quantity: "1", unitPriceCents: 3000, taxRateBasisPoints: 0 },
      { quantity: "1", unitPriceCents: 4000, taxRateBasisPoints: 2000 },
    ]);

    expect(t.byRate).toEqual([
      { rateBasisPoints: 0, baseCents: 3000, taxCents: 0 },
      { rateBasisPoints: 1000, baseCents: 10000, taxCents: 1000 },
      { rateBasisPoints: 2000, baseCents: 14000, taxCents: 2800 },
    ]);
    expect(t.subtotalCents).toBe(27000);
    expect(t.taxCents).toBe(3800);
    expect(t.totalCents).toBe(30800);
  });

  it("computes VAT per rate, not per line, so tiny lines do not drift", () => {
    // Ten lines of 7 cents at 20%. Per-line VAT (1.4 -> 1 cent each) would total 10 cents;
    // VAT on the summed 70 cent base is 14 cents.
    const lines = Array.from({ length: 10 }, () => ({
      quantity: "1",
      unitPriceCents: 7,
      taxRateBasisPoints: 2000,
    }));

    expect(computeTotals(lines).taxCents).toBe(14);
  });

  it("treats a missing rate as 0%", () => {
    const t = computeTotals([{ quantity: "1", unitPriceCents: 500 }]);

    expect(t.taxCents).toBe(0);
    expect(t.totalCents).toBe(500);
  });

  it("returns zeros for no lines", () => {
    expect(computeTotals([])).toEqual({ subtotalCents: 0, taxCents: 0, totalCents: 0, byRate: [] });
  });

  it("rejects a rate that is not a Moroccan VAT rate", () => {
    for (const rate of [1, 500, 1900, 2100, 10000]) {
      expect(
        codeOf(() => computeTotals([{ quantity: "1", unitPriceCents: 100, taxRateBasisPoints: rate }])),
      ).toBe("INVALID_LINE");
    }
  });

  it("stays exact for large amounts that would lose precision as floats", () => {
    // About 9e12 cents: exact in BigInt, close to where Number arithmetic starts to hurt.
    const t = computeTotals([
      { quantity: "1", unitPriceCents: 9007199254740, taxRateBasisPoints: 2000 },
    ]);

    expect(t.taxCents).toBe(1801439850948);
    expect(t.totalCents).toBe(10808639105688);
  });

  it("rejects totals beyond the safe integer range", () => {
    expect(
      codeOf(() =>
        computeTotals([{ quantity: "1", unitPriceCents: 9007199254740991, taxRateBasisPoints: 2000 }]),
      ),
    ).toBe("INVALID_LINE");
  });
});
