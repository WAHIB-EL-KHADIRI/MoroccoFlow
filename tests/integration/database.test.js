import { afterEach, describe, expect, it } from "vitest";
import { clearDatabase, getAll, put, seedDatabase, snapshot } from "../../src/core/database.js";

afterEach(async () => {
  await clearDatabase();
});

describe("IndexedDB repository", () => {
  it("seeds coherent Moroccan demo data", async () => {
    await seedDatabase();
    const clients = await getAll("clients");
    const invoices = await getAll("invoices");
    expect(clients.length).toBeGreaterThanOrEqual(5);
    expect(invoices.every((invoice) => Number.isInteger(invoice.amount))).toBe(true);
  });

  it("persists and exports entities", async () => {
    await put("clients", {
      id: "test-client",
      name: "Test",
      company: "Test SARL",
      createdAt: new Date().toISOString(),
    });
    const data = await snapshot();
    expect(data.clients).toContainEqual(expect.objectContaining({ id: "test-client" }));
  });
});
