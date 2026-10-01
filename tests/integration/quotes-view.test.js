/**
 * The quotes page against a stubbed API: what it renders for each lifecycle state,
 * which actions each role is offered, and what it sends when a quote is accepted.
 * The server is the authority on all of this; these tests pin that the UI neither
 * hides a legitimate action nor offers one the server would refuse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const quotesApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  accept: vi.fn(),
}));

vi.mock("../../src/core/api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  apiEnabled: true,
  quotesApi,
}));

const { appStore } = await import("../../src/core/store.js");
await import("../../src/features/quotes/index.js");

HTMLDialogElement.prototype.showModal ??= function showModal() {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function close() {
  this.open = false;
};

const CLIENT = "c0000000-0000-4000-8000-000000000001";
const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const quote = (overrides = {}) => ({
  id: "q0000000-0000-4000-8000-000000000001",
  clientId: CLIENT,
  number: "DV-2026-001",
  issueDate: "2026-09-01",
  validUntil: "2099-12-31",
  status: "sent",
  subtotalCents: "1666667",
  taxCents: "333333",
  totalCents: "2000000",
  version: 2,
  ...overrides,
});
const detail = (overrides = {}) => ({
  ...quote(overrides),
  effectiveStatus: overrides.effectiveStatus ?? overrides.status ?? "sent",
  project: null,
  obligation: null,
  history: [{ action: "quote.created", actorName: "Sara", createdAt: "2026-09-01T09:30:00Z" }],
});

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

async function mount(permissions) {
  appStore.state.user = { permissions };
  appStore.state.data.clients = [{ id: CLIENT, company: "Atlas Services SARL" }];
  const view = document.createElement("mf-quotes-view");
  document.body.append(view);
  await settle();
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  quotesApi.list.mockResolvedValue([
    quote(),
    quote({ id: "q2", number: "DV-2026-002", validUntil: yesterday }),
  ]);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("quotes page", () => {
  it("lists quotes from the API with their client, total and derived expiry", async () => {
    const view = await mount(["quotes:*"]);
    const rows = [...view.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Atlas Services SARL");
    expect(rows[0].querySelector("mf-status-badge").getAttribute("status")).toBe("sent");
    expect(rows[1].querySelector("mf-status-badge").getAttribute("status")).toBe("expired");
  });

  it("offers no write action to a read-only role", async () => {
    quotesApi.get.mockResolvedValue(detail());
    const view = await mount(["quotes:read"]);
    expect(view.querySelector("#add-quote")).toBeNull();
    view.querySelector(".open-quote").click();
    await settle();
    expect(view.querySelector("#accept-form")).toBeNull();
    expect(view.querySelector("#edit-quote")).toBeNull();
  });

  it("accepts with the chosen due date and one idempotency key per dialog", async () => {
    quotesApi.get.mockResolvedValue(detail());
    quotesApi.accept.mockResolvedValue({ replayed: false });
    const view = await mount(["quotes:*"]);
    view.querySelector(".open-quote").click();
    await settle();

    const form = view.querySelector("#accept-form");
    form.querySelector("#dueDate").value = "2026-12-31";
    form.querySelector("#projectName").value = "Site vitrine";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();

    expect(quotesApi.accept).toHaveBeenCalledTimes(1);
    const [id, body, key] = quotesApi.accept.mock.calls[0];
    expect(id).toBe(quote().id);
    expect(body).toEqual({ dueDate: "2026-12-31", projectName: "Site vitrine" });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("shows an accepted quote as closed, with its project and history", async () => {
    quotesApi.get.mockResolvedValue({
      ...detail({ status: "accepted" }),
      project: { id: "p1", name: "Site vitrine", status: "active" },
    });
    const view = await mount(["quotes:*"]);
    view.querySelector(".open-quote").click();
    await settle();
    const dialog = view.querySelector("#quote-detail");
    expect(dialog.querySelector("#accept-form")).toBeNull();
    expect(dialog.querySelector("#edit-quote")).toBeNull();
    expect(dialog.textContent).toContain("Site vitrine");
    expect(dialog.textContent).toContain("Sara");
  });

  it("does not offer acceptance of an expired quote", async () => {
    quotesApi.get.mockResolvedValue(detail({ validUntil: yesterday, effectiveStatus: "expired" }));
    const view = await mount(["quotes:*"]);
    view.querySelector(".open-quote").click();
    await settle();
    expect(view.querySelector("#accept-form")).toBeNull();
  });

  it("sends typed amounts as exact centimes and creates drafts only", async () => {
    quotesApi.create.mockResolvedValue({});
    const view = await mount(["quotes:*"]);
    view.querySelector("#add-quote").click();
    const form = view.querySelector("#quote-form");
    form.querySelector("#clientId").value = CLIENT;
    form.querySelector("#subtotal").value = "16 666,67";
    form.querySelector("#tax").value = "3333,33";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    const [body] = quotesApi.create.mock.calls[0];
    expect(body).toMatchObject({
      clientId: CLIENT,
      subtotalCents: 1_666_667,
      taxCents: 333_333,
      status: "draft",
      currency: "MAD",
    });
  });

  it("shows the server's reason when an action is refused", async () => {
    quotesApi.get.mockResolvedValue(detail());
    quotesApi.accept.mockRejectedValue(
      Object.assign(new Error("past validity"), { code: "QUOTE_EXPIRED", status: 409 }),
    );
    const view = await mount(["quotes:*"]);
    view.querySelector(".open-quote").click();
    await settle();
    view.querySelector("#accept-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(view.querySelector("#detail-error").textContent).toContain("date de validité");
  });
});
