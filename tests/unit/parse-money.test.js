import { describe, expect, it } from "vitest";
import { parseMoney } from "../../src/shared/formatters.js";

describe("parseMoney", () => {
  it("reads Moroccan-typed amounts into exact centimes", () => {
    expect(parseMoney("20000")).toBe(2_000_000);
    expect(parseMoney("1 250,5")).toBe(125_050);
    expect(parseMoney("1250.50")).toBe(125_050);
    expect(parseMoney("0,29")).toBe(29);
    expect(parseMoney("0")).toBe(0);
  });

  it("never goes through a float, even where 0.1-style values round badly", () => {
    // 1.005 * 100 === 100.49999999999999 in IEEE-754; the parser never multiplies.
    expect(parseMoney("1.01")).toBe(101);
    expect(parseMoney("4.35")).toBe(435);
  });

  it("accepts digits typed on an Arabic keyboard", () => {
    expect(parseMoney("١٠٠")).toBe(10_000);
    expect(parseMoney("١٢٥٠٫٥")).toBe(125_050);
    expect(parseMoney("۲۰۰۰۰")).toBe(2_000_000);
  });

  it("refuses negatives, a third decimal, and anything that is not an amount", () => {
    for (const input of ["-5", "1.005", "12,5,0", "abc", "", "1e3"]) {
      expect(parseMoney(input)).toBeNull();
    }
  });
});
