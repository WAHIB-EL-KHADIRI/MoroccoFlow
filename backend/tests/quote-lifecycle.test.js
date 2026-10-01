import { describe, expect, it } from "vitest";
import {
  assertQuoteDeletable,
  assertQuoteUpdate,
  effectiveQuoteStatus,
} from "../src/modules/quotes/lifecycle.js";

const code = (fn) => {
  try {
    fn();
    return "allowed";
  } catch (error) {
    return error.code;
  }
};

describe("quote lifecycle", () => {
  it("allows only forward transitions from open quotes", () => {
    expect(code(() => assertQuoteUpdate({ status: "draft" }, { status: "sent" }))).toBe("allowed");
    expect(code(() => assertQuoteUpdate({ status: "draft" }, { notes: "x" }))).toBe("allowed");
    expect(code(() => assertQuoteUpdate({ status: "sent" }, { status: "rejected" }))).toBe(
      "allowed",
    );
    expect(code(() => assertQuoteUpdate({ status: "draft" }, { status: "rejected" }))).toBe(
      "INVALID_TRANSITION",
    );
    expect(code(() => assertQuoteUpdate({ status: "sent" }, { status: "draft" }))).toBe(
      "INVALID_TRANSITION",
    );
  });

  it("freezes a quote once it is accepted, rejected or cancelled", () => {
    for (const status of ["accepted", "rejected", "cancelled"]) {
      expect(code(() => assertQuoteUpdate({ status }, { notes: "x" }))).toBe("QUOTE_LOCKED");
    }
    expect(code(() => assertQuoteDeletable({ status: "accepted" }))).toBe("QUOTE_LOCKED");
    expect(code(() => assertQuoteDeletable({ status: "rejected" }))).toBe("allowed");
  });

  it("derives expired only for open quotes", () => {
    expect(effectiveQuoteStatus("sent", true)).toBe("expired");
    expect(effectiveQuoteStatus("draft", true)).toBe("expired");
    expect(effectiveQuoteStatus("accepted", true)).toBe("accepted");
    expect(effectiveQuoteStatus("sent", false)).toBe("sent");
  });
});
