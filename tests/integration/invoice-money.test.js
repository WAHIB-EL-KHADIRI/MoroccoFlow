/**
 * The invoice form is the one place in the product where a human types a
 * decimal amount. Everything downstream -- the outbox, the API schema, the
 * bigint columns -- assumes what leaves this form is an integer number of
 * centimes. If that assumption breaks, nothing downstream notices: a float
 * simply flows through and rounds somewhere else, months later, on a total.
 *
 * So this exercises the real component against the real store and the real
 * IndexedDB repository, and asserts on what was persisted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appStore } from "../../src/core/store.js";
import { clearDatabase, getAll, seedDatabase } from "../../src/core/database.js";
import "../../src/features/finance/index.js";

// jsdom ships HTMLDialogElement without its methods; the component closes the
// dialog after a successful save. Browsers are covered by the Playwright
// journeys -- here the dialog is scaffolding, not the subject.
HTMLDialogElement.prototype.showModal ??= function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close() {
  this.open = false;
};

/**
 * The submit handler is async, so the write lands a few microtasks after the
 * event. Poll the repository for a bounded number of ticks: a record that has
 * not appeared after the outbox and IndexedDB have both quiesced is genuinely
 * absent, which is what the rejection case needs to assert.
 */
async function readInvoice(number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const invoices = await getAll("invoices");
    const match = invoices.find((invoice) => invoice.number === number);
    if (match) return match;
  }
  return undefined;
}

/** Drives the real dialog form the way a user does, and returns the record. */
async function submitInvoice({ number, amount, status = "draft" }) {
  const view = document.createElement("mf-finance-view");
  document.body.append(view);
  const form = view.querySelector("#invoice-form");
  const client = appStore.state.data.clients[0];

  form.querySelector("#number").value = number;
  form.querySelector("#clientId").value = client.id;
  form.querySelector("#date").value = "2026-03-01";
  form.querySelector("#dueDate").value = "2026-03-31";
  form.querySelector("#amount").value = amount;
  form.querySelector("#status").value = status;

  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  // Validation runs synchronously inside the handler, before any await, so the
  // field errors are already rendered at this point.
  const fieldError = form.querySelector("#amount-error").textContent;
  const stored = await readInvoice(number);
  await appStore.reload();

  view.remove();
  return { stored, fieldError };
}

/** The view re-renders on every store change, so leaving one attached would
 *  let a finished test keep reacting to the next one. */
function detachViews() {
  document.querySelectorAll("mf-finance-view").forEach((view) => view.remove());
}

beforeEach(async () => {
  detachViews();
  await clearDatabase();
  await seedDatabase();
  await appStore.reload();
});

afterEach(detachViews);

describe("dirhams typed by a human become integer centimes", () => {
  it("stores ordinary Moroccan amounts exactly", async () => {
    const cases = [
      ["12.34", 1234],
      ["19.99", 1999],
      ["0.01", 1],
      ["1234.56", 123456],
      ["8500", 850000],
      ["99999.99", 9999999],
    ];
    for (const [typed, expected] of cases) {
      const { stored } = await submitInvoice({ number: `FA-2026-${expected}`, amount: typed });
      expect(stored.amount).toBe(expected);
      expect(Number.isInteger(stored.amount)).toBe(true);
    }
  });

  it("never stores a fractional centime, whatever the user types", async () => {
    // 1234.565 * 100 is 123456.49999999999 in IEEE-754, and 8.615 * 100 is
    // 861.4999999999999. Truncation would lose a centime on the first and a
    // naive `* 100` without rounding would store a fraction on both.
    const awkward = ["1234.565", "8.615", "0.07", "0.29", "1.005", "33.333", "2.675"];
    for (const [index, typed] of awkward.entries()) {
      const { stored } = await submitInvoice({ number: `FA-2026-X${index}`, amount: typed });

      expect(Number.isInteger(stored.amount)).toBe(true);
      // Whatever the double rounds to, it must be within one centime of the
      // amount the user meant -- never a truncation to the dirham, never a
      // silent doubling, never NaN.
      expect(Math.abs(stored.amount - Number(typed) * 100)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps a full ledger summable without drift", async () => {
    const typed = ["10.10", "20.20", "30.30", "0.05", "999.99"];
    for (const [index, amount] of typed.entries()) {
      await submitInvoice({ number: `FA-2026-S${index}`, amount, status: "paid" });
    }

    const invoices = (await getAll("invoices")).filter((invoice) =>
      invoice.number.startsWith("FA-2026-S"),
    );
    const total = invoices.reduce((sum, invoice) => sum + invoice.amount, 0);

    expect(invoices).toHaveLength(typed.length);
    expect(invoices.every((invoice) => Number.isInteger(invoice.amount))).toBe(true);
    // 1060,64 MAD, to the centime, from five separate form submissions.
    expect(total).toBe(106_064);
  });

  it("refuses a negative or non-numeric amount instead of storing garbage", async () => {
    for (const amount of ["-50", "0", "abc", ""]) {
      const { stored, fieldError } = await submitInvoice({ number: "FA-2026-REJECTED", amount });
      expect(stored).toBeUndefined();
      expect(fieldError).toBe("Le montant doit être supérieur à zéro");
    }
  });
});
