import { describe, expect, it } from "vitest";
import { csvCell, escapeHTML, safeUrl } from "../../src/core/security.js";

describe("security helpers", () => {
  it("escapes user-controlled HTML", () => {
    expect(escapeHTML('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  it("blocks unsafe URL protocols", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("https://example.com")).toContain("https://example.com");
  });

  it("neutralizes spreadsheet formulas", () => {
    expect(csvCell("=2+2")).toBe('"\'=2+2"');
    expect(csvCell('hello "Wahib"')).toBe('"hello ""Wahib"""');
  });
});
