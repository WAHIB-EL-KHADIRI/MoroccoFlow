import { describe, expect, it } from "vitest";
import { validateClient, validateInvoice } from "../../src/shared/validation.js";

describe("business validation", () => {
  it("accepts a complete Moroccan client", () => {
    expect(
      validateClient({
        name: "Salma Bennani",
        company: "Atlas Studio",
        email: "salma@atlas.demo",
        phone: "+212661234567",
      }),
    ).toEqual({});
  });

  it("rejects unsafe or incomplete client input", () => {
    const errors = validateClient({ name: "", company: "", email: "bad", phone: "123" });
    expect(Object.keys(errors)).toEqual(["name", "company", "email", "phone"]);
  });

  it("requires positive invoice values", () => {
    expect(validateInvoice({ clientId: "", number: "", date: "", amount: "-12" })).toMatchObject({
      clientId: expect.any(String),
      number: expect.any(String),
      date: expect.any(String),
      amount: expect.any(String),
    });
  });
});
