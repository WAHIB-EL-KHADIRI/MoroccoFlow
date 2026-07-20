import { appStore } from "../../core/store.js";
import { t } from "../../core/i18n.js";
import { escapeHTML } from "../../core/security.js";
import { formatDate, formatMoney } from "../../shared/formatters.js";
import { validateInvoice } from "../../shared/validation.js";
import { icon } from "../../design-system/icons.js";
import { toast } from "../../design-system/components.js";
import { pageHeader, clientName, emptyState, downloadCsv } from "../shared.js";

class MFFinanceView extends HTMLElement {
  connectedCallback() {
    this.unsubscribe = appStore.subscribe(() => this.render());
    this.onLocale = () => this.render();
    window.addEventListener("mf:locale-change", this.onLocale);
    this.render();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    window.removeEventListener("mf:locale-change", this.onLocale);
  }

  render() {
    const { invoices, clients, expenses } = appStore.state.data;
    const paid = invoices
      .filter((item) => item.status === "paid")
      .reduce((sum, item) => sum + item.amount, 0);
    const pending = invoices
      .filter((item) => item.status === "pending")
      .reduce((sum, item) => sum + item.amount, 0);
    const overdue = invoices
      .filter((item) => item.status === "overdue")
      .reduce((sum, item) => sum + item.amount, 0);
    const spending = expenses.reduce((sum, item) => sum + item.amount, 0);
    const nextNumber = `FA-2026-${String(Math.max(0, ...invoices.map((i) => Number(i.number.split("-").at(-1)))) + 1).padStart(3, "0")}`;

    this.innerHTML = `<section class="page" aria-labelledby="finance-title">
      ${pageHeader({
        eyebrow: "FINANCE",
        title: t("invoices"),
        subtitle: "Facturation marocaine · MAD · suivi des paiements",
        actions: `<button class="button" id="print-report">${icon("download")} ${t("exportPdf")}</button><button class="button primary" id="add-invoice">${icon("plus")} ${t("addInvoice")}</button>`,
      }).replace('class="page-title"', 'class="page-title" id="finance-title"')}

      <div class="stats-grid">
        <mf-stat-card data-label="${t("paid")}" data-value="${formatMoney(paid)}" data-meta="${invoices.filter((i) => i.status === "paid").length} ${t("invoices").toLowerCase()}" data-icon="check" data-tone="emerald"></mf-stat-card>
        <mf-stat-card data-label="${t("pending")}" data-value="${formatMoney(pending)}" data-meta="${invoices.filter((i) => i.status === "pending").length} ${t("invoices").toLowerCase()}" data-icon="clock" data-tone="saffron"></mf-stat-card>
        <mf-stat-card data-label="${t("overdue")}" data-value="${formatMoney(overdue)}" data-meta="${invoices.filter((i) => i.status === "overdue").length} ${t("invoices").toLowerCase()}" data-icon="alert" data-tone="clay" data-negative="true"></mf-stat-card>
        <mf-stat-card data-label="${t("expenses")}" data-value="${formatMoney(spending)}" data-meta="${expenses.length} ${t("transactions").toLowerCase()}" data-icon="wallet" data-tone="blue"></mf-stat-card>
      </div>

      <div class="toolbar">
        <label class="sr-only" for="invoice-search">${t("search")}</label>
        <input class="field" id="invoice-search" type="search" placeholder="${t("search")}">
        <select class="select" id="invoice-filter" aria-label="${t("status")}">
          <option value="">${t("status")} · Tous</option>
          ${["paid", "pending", "overdue", "draft"].map((status) => `<option value="${status}">${t(status)}</option>`).join("")}
        </select>
        <span class="toolbar-spacer"></span>
        <button class="button" id="export-invoices">${icon("download")} ${t("exportCsv")}</button>
      </div>

      ${
        invoices.length
          ? `<div class="table-shell">
              <table>
                <thead><tr><th>${t("number")}</th><th>${t("client")}</th><th>${t("date")}</th><th>${t("status")}</th><th class="text-end">${t("amount")}</th></tr></thead>
                <tbody>
                  ${invoices
                    .slice()
                    .sort((a, b) => new Date(b.date) - new Date(a.date))
                    .map(
                      (
                        invoice,
                      ) => `<tr class="invoice-row" data-search="${escapeHTML(`${invoice.number} ${clientName(clients, invoice.clientId)} ${invoice.status}`.toLowerCase())}">
                        <td><strong>${escapeHTML(invoice.number)}</strong><br><span class="muted">${t("dueDate")} ${formatDate(invoice.dueDate)}</span></td>
                        <td>${escapeHTML(clientName(clients, invoice.clientId))}</td>
                        <td>${formatDate(invoice.date)}</td>
                        <td><mf-status-badge status="${invoice.status}"></mf-status-badge></td>
                        <td class="text-end"><strong>${formatMoney(invoice.amount)}</strong></td>
                      </tr>`,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
          : emptyState(
              `<button class="button primary" id="empty-add-invoice">${t("addInvoice")}</button>`,
            )
      }

      <dialog id="invoice-dialog" aria-labelledby="invoice-dialog-title">
        <form id="invoice-form" novalidate>
          <div class="dialog-head"><h2 class="dialog-title" id="invoice-dialog-title">${t("addInvoice")}</h2><button type="button" class="icon-button close-dialog" aria-label="${t("close")}">${icon("close")}</button></div>
          <div class="dialog-body form-grid">
            ${this.field("number", t("number"), nextNumber)}
            <div class="form-group"><label for="clientId">${t("client")}</label><select id="clientId" name="clientId"><option value="">—</option>${clients.map((client) => `<option value="${client.id}">${escapeHTML(client.company)}</option>`).join("")}</select><span class="field-error" id="clientId-error"></span></div>
            ${this.field("date", t("date"), new Date().toISOString().slice(0, 10), "date")}
            ${this.field("dueDate", t("dueDate"), new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), "date")}
            ${this.field("amount", `${t("amount")} (MAD)`, "0", "number")}
            <div class="form-group"><label for="status">${t("status")}</label><select id="status" name="status"><option value="draft">${t("draft")}</option><option value="pending">${t("pending")}</option><option value="paid">${t("paid")}</option></select></div>
          </div>
          <div class="dialog-actions"><button type="button" class="button close-dialog">${t("cancel")}</button><button class="button primary" type="submit">${t("save")}</button></div>
        </form>
      </dialog>
      <p class="footer-credit">Amounts are stored as integer centimes · Printable A4 PDF layout</p>
    </section>`;
    this.bindEvents();
  }

  field(name, label, value, type = "text") {
    return `<div class="form-group"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${value}" required ${type === "number" ? 'min="0.01" step="0.01"' : ""}><span class="field-error" id="${name}-error"></span></div>`;
  }

  bindEvents() {
    const dialog = this.querySelector("#invoice-dialog");
    const open = () => dialog.showModal();
    this.querySelector("#add-invoice")?.addEventListener("click", open);
    this.querySelector("#empty-add-invoice")?.addEventListener("click", open);
    this.querySelectorAll(".close-dialog").forEach((button) =>
      button.addEventListener("click", () => dialog.close()),
    );
    this.querySelector("#invoice-search")?.addEventListener("input", (event) => {
      const query = event.target.value.toLowerCase();
      this.querySelectorAll(".invoice-row").forEach((row) =>
        row.classList.toggle("hidden", !row.dataset.search.includes(query)),
      );
    });
    this.querySelector("#invoice-filter")?.addEventListener("change", (event) => {
      const value = event.target.value;
      this.querySelectorAll(".invoice-row").forEach((row) =>
        row.classList.toggle("hidden", Boolean(value && !row.dataset.search.endsWith(value))),
      );
    });
    this.querySelector("#print-report")?.addEventListener("click", () => window.print());
    this.querySelector("#export-invoices")?.addEventListener("click", () => {
      const { invoices, clients } = appStore.state.data;
      downloadCsv(
        "moroccoflow-invoices.csv",
        ["Number", "Client", "Date", "Due date", "Status", "Amount MAD"],
        invoices.map((invoice) => [
          invoice.number,
          clientName(clients, invoice.clientId),
          invoice.date.slice(0, 10),
          invoice.dueDate.slice(0, 10),
          invoice.status,
          (invoice.amount / 100).toFixed(2),
        ]),
      );
    });
    this.querySelector("#invoice-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const errors = validateInvoice(values);
      if (appStore.state.data.invoices.some((invoice) => invoice.number === values.number)) {
        errors.number = "Numéro déjà utilisé";
      }
      this.querySelectorAll(".field-error").forEach((node) => (node.textContent = ""));
      this.querySelectorAll("[aria-invalid]").forEach((node) =>
        node.removeAttribute("aria-invalid"),
      );
      if (Object.keys(errors).length) {
        for (const [field, message] of Object.entries(errors)) {
          this.querySelector(`#${field}`)?.setAttribute("aria-invalid", "true");
          const error = this.querySelector(`#${field}-error`);
          if (error) error.textContent = message;
        }
        this.querySelector(`#${Object.keys(errors)[0]}`)?.focus();
        return;
      }
      await appStore.save("invoices", {
        ...values,
        amount: Math.round(Number(values.amount) * 100),
        date: new Date(values.date).toISOString(),
        dueDate: new Date(values.dueDate).toISOString(),
      });
      dialog.close();
      toast(t("saved"));
    });
  }
}

customElements.define("mf-finance-view", MFFinanceView);
export const tag = "mf-finance-view";
