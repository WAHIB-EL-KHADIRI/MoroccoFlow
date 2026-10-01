import { appStore } from "../../core/store.js";
import { apiEnabled, quotesApi } from "../../core/api.js";
import { t } from "../../core/i18n.js";
import { escapeHTML } from "../../core/security.js";
import { formatDate, formatMoney, parseMoney } from "../../shared/formatters.js";
import { icon } from "../../design-system/icons.js";
import { toast } from "../../design-system/components.js";
import { pageHeader, clientName, emptyState } from "../shared.js";

const OPEN = new Set(["draft", "sent"]);
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const dateOnly = (value) => (value ? String(value).slice(0, 10) : "");

function granted(permission) {
  const grants = appStore.state.user?.permissions || [];
  const [namespace] = permission.split(":");
  return grants.includes("*") || grants.includes(permission) || grants.includes(`${namespace}:*`);
}

/**
 * List rows carry the stored status only; "expired" is derived here for display, and
 * the server re-derives it from the tenant's business date before any acceptance.
 */
function displayStatus(quote) {
  return OPEN.has(quote.status) && quote.validUntil && dateOnly(quote.validUntil) < today()
    ? "expired"
    : quote.status;
}

function errorMessage(error) {
  const key = `error.${error?.code}`;
  const translated = t(key);
  return translated === key ? error?.message || t("error") : translated;
}

class MFQuotesView extends HTMLElement {
  quotes = [];
  state = "loading";
  failure = null;
  query = "";
  statusFilter = "";
  detail = null;

  connectedCallback() {
    this.onLocale = () => this.render();
    window.addEventListener("mf:locale-change", this.onLocale);
    if (!apiEnabled) {
      this.state = "unavailable";
      this.render();
      return;
    }
    this.load();
  }

  disconnectedCallback() {
    window.removeEventListener("mf:locale-change", this.onLocale);
  }

  async load() {
    this.state = "loading";
    this.render();
    try {
      this.quotes = await quotesApi.list({ q: this.query });
      this.state = "ready";
    } catch (error) {
      this.state = "error";
      this.failure = errorMessage(error);
    }
    this.render();
  }

  visibleQuotes() {
    return this.quotes.filter(
      (quote) => !this.statusFilter || displayStatus(quote) === this.statusFilter,
    );
  }

  render() {
    const canWrite = granted("quotes:write");
    this.innerHTML = `<section class="page" aria-labelledby="quotes-title">
      ${pageHeader({
        eyebrow: "SALES",
        title: t("quotes"),
        subtitle: t("notLegalInvoice"),
        actions:
          canWrite && this.state === "ready"
            ? `<button class="button primary" id="add-quote">${icon("plus")} ${t("addQuote")}</button>`
            : "",
      }).replace('class="page-title"', 'class="page-title" id="quotes-title"')}
      ${this.body(canWrite)}
      <dialog id="quote-dialog" aria-labelledby="quote-dialog-title"></dialog>
      <dialog id="quote-detail" aria-labelledby="quote-detail-title"></dialog>
    </section>`;
    this.bindEvents();
  }

  body(canWrite) {
    if (this.state === "unavailable") {
      return `<div class="state-panel"><div><span class="state-icon">${icon("lock")}</span><p>${t("companyModeOnly")}</p></div></div>`;
    }
    if (this.state === "loading") {
      return '<div class="skeleton" style="height:180px" aria-busy="true"></div>';
    }
    if (this.state === "error") {
      return `<div class="state-panel" role="alert"><div><span class="state-icon">${icon("alert")}</span><p>${escapeHTML(this.failure)}</p><button class="button primary" id="retry-quotes">${t("retry")}</button></div></div>`;
    }
    const { clients } = appStore.state.data;
    const rows = this.visibleQuotes();
    const statuses = ["draft", "sent", "expired", "accepted", "rejected", "cancelled"];
    return `<div class="toolbar">
        <label class="sr-only" for="quote-search">${t("search")}</label>
        <input class="field" id="quote-search" type="search" value="${escapeHTML(this.query)}" placeholder="${t("search")}">
        <select class="select" id="quote-filter" aria-label="${t("status")}">
          <option value="">${t("allStatuses")}</option>
          ${statuses.map((status) => `<option value="${status}" ${this.statusFilter === status ? "selected" : ""}>${t(status)}</option>`).join("")}
        </select>
      </div>
      ${
        rows.length
          ? `<div class="table-shell"><table>
              <thead><tr><th>${t("number")}</th><th>${t("client")}</th><th>${t("issueDate")}</th><th>${t("validUntil")}</th><th>${t("status")}</th><th class="text-end">${t("total")}</th></tr></thead>
              <tbody>${rows
                .map(
                  (quote) => `<tr>
                    <td><button class="link-button open-quote" data-id="${escapeHTML(quote.id)}"><strong>${escapeHTML(quote.number)}</strong></button></td>
                    <td>${escapeHTML(clientName(clients, quote.clientId))}</td>
                    <td>${formatDate(quote.issueDate)}</td>
                    <td>${quote.validUntil ? formatDate(quote.validUntil) : "-"}</td>
                    <td><mf-status-badge status="${displayStatus(quote)}"></mf-status-badge></td>
                    <td class="text-end"><strong>${formatMoney(Number(quote.totalCents))}</strong></td>
                  </tr>`,
                )
                .join("")}</tbody></table></div>`
          : emptyState(
              canWrite && !this.query && !this.statusFilter
                ? `<button class="button primary" id="empty-add-quote">${t("addQuote")}</button>`
                : "",
            )
      }`;
  }

  bindEvents() {
    this.querySelector("#retry-quotes")?.addEventListener("click", () => this.load());
    this.querySelector("#add-quote")?.addEventListener("click", () => this.openForm());
    this.querySelector("#empty-add-quote")?.addEventListener("click", () => this.openForm());
    this.querySelector("#quote-search")?.addEventListener("change", (event) => {
      this.query = event.target.value.trim();
      this.load();
    });
    this.querySelector("#quote-filter")?.addEventListener("change", (event) => {
      this.statusFilter = event.target.value;
      this.render();
    });
    this.querySelectorAll(".open-quote").forEach((button) =>
      button.addEventListener("click", () => this.openDetail(button.dataset.id)),
    );
  }

  nextNumber() {
    const year = today().slice(0, 4);
    const used = this.quotes
      .map((quote) => /^DV-(\d{4})-(\d+)$/.exec(quote.number))
      .filter((match) => match?.[1] === year)
      .map((match) => Number(match[2]));
    return `DV-${year}-${String(Math.max(0, ...used) + 1).padStart(3, "0")}`;
  }

  /** Create when `quote` is absent, edit an open quote otherwise. */
  openForm(quote) {
    const { clients } = appStore.state.data;
    const dialog = this.querySelector("#quote-dialog");
    const value = (field, fallback = "") => escapeHTML(String(quote?.[field] ?? fallback));
    const mad = (centimes) => (Number(centimes || 0) / 100).toFixed(2);
    dialog.innerHTML = `<form id="quote-form" novalidate>
      <div class="dialog-head"><h2 class="dialog-title" id="quote-dialog-title">${t(quote ? "editQuote" : "addQuote")}</h2><button type="button" class="icon-button close-dialog" aria-label="${t("close")}">${icon("close")}</button></div>
      <div class="dialog-body form-grid">
        ${field("number", t("number"), value("number", this.nextNumber()))}
        <div class="form-group"><label for="clientId">${t("client")}</label><select id="clientId" name="clientId" required><option value="">-</option>${clients
          .map(
            (client) =>
              `<option value="${escapeHTML(client.id)}" ${quote?.clientId === client.id ? "selected" : ""}>${escapeHTML(client.company)}</option>`,
          )
          .join("")}</select><span class="field-error" id="clientId-error"></span></div>
        ${field("issueDate", t("issueDate"), dateOnly(quote?.issueDate) || today(), "date")}
        ${field("validUntil", t("validUntil"), dateOnly(quote?.validUntil) || plusDays(30), "date")}
        ${field("subtotal", t("subtotal"), quote ? mad(quote.subtotalCents) : "", "text", 'inputmode="decimal"')}
        ${field("tax", t("taxAmount"), quote ? mad(quote.taxCents) : "0", "text", 'inputmode="decimal"')}
        <div class="form-group"><label for="notes">${t("notes")}</label><textarea id="notes" name="notes" maxlength="5000">${value("notes")}</textarea></div>
      </div>
      <p class="form-error" role="alert" id="quote-form-error"></p>
      <div class="dialog-actions"><button type="button" class="button close-dialog">${t("cancel")}</button><button class="button primary" type="submit">${t("save")}</button></div>
    </form>`;
    const key = crypto.randomUUID();
    dialog
      .querySelectorAll(".close-dialog")
      .forEach((button) => button.addEventListener("click", () => dialog.close()));
    dialog.querySelector("#quote-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const errors = {};
      if (!values.number?.trim()) errors.number = t("number");
      if (!values.clientId) errors.clientId = t("client");
      const subtotalCents = parseMoney(values.subtotal);
      const taxCents = parseMoney(values.tax || "0");
      if (subtotalCents === null) errors.subtotal = t("amount");
      if (taxCents === null) errors.tax = t("amount");
      if (values.validUntil && values.validUntil < values.issueDate)
        errors.validUntil = t("validUntil");
      dialog.querySelectorAll(".field-error").forEach((node) => (node.textContent = ""));
      dialog
        .querySelectorAll("[aria-invalid]")
        .forEach((node) => node.removeAttribute("aria-invalid"));
      if (Object.keys(errors).length) {
        for (const [name, message] of Object.entries(errors)) {
          dialog.querySelector(`#${name}`)?.setAttribute("aria-invalid", "true");
          const slot = dialog.querySelector(`#${name}-error`);
          if (slot) slot.textContent = message;
        }
        dialog.querySelector(`#${Object.keys(errors)[0]}`)?.focus();
        return;
      }
      const body = {
        clientId: values.clientId,
        number: values.number.trim(),
        issueDate: values.issueDate,
        validUntil: values.validUntil || null,
        subtotalCents,
        taxCents,
        currency: "MAD",
        notes: values.notes?.trim() || null,
      };
      try {
        if (quote) await quotesApi.update(quote.id, { ...body, version: quote.version });
        else await quotesApi.create({ ...body, status: "draft" }, key);
        dialog.close();
        toast(t("saved"));
        await this.load();
        if (quote) await this.openDetail(quote.id);
      } catch (error) {
        dialog.querySelector("#quote-form-error").textContent = errorMessage(error);
      }
    });
    if (!dialog.open) dialog.showModal();
  }

  async openDetail(id) {
    const dialog = this.querySelector("#quote-detail");
    dialog.innerHTML = `<div class="dialog-body"><div class="skeleton" style="height:160px" aria-busy="true"></div></div>`;
    if (!dialog.open) dialog.showModal();
    try {
      this.detail = await quotesApi.get(id);
    } catch (error) {
      dialog.innerHTML = `<div class="dialog-body" role="alert"><p>${escapeHTML(errorMessage(error))}</p><button class="button close-dialog">${t("close")}</button></div>`;
      dialog.querySelector(".close-dialog").addEventListener("click", () => dialog.close());
      return;
    }
    this.renderDetail();
  }

  renderDetail() {
    const quote = this.detail;
    const dialog = this.querySelector("#quote-detail");
    const { clients } = appStore.state.data;
    const canWrite = granted("quotes:write");
    const open = OPEN.has(quote.status) && quote.effectiveStatus !== "expired";
    const actions = [];
    if (canWrite && open) {
      actions.push(`<button class="button" id="edit-quote">${t("editQuote")}</button>`);
      if (quote.status === "draft") {
        actions.push(`<button class="button" data-transition="sent">${t("markSent")}</button>`);
      }
      if (quote.status === "sent") {
        actions.push(
          `<button class="button" data-transition="rejected">${t("markRejected")}</button>`,
        );
      }
      actions.push(`<button class="button" data-transition="cancelled">${t("voidQuote")}</button>`);
    }
    const obligation = quote.obligation;
    dialog.innerHTML = `<div class="dialog-head"><div><h2 class="dialog-title" id="quote-detail-title">${escapeHTML(quote.number)}</h2><mf-status-badge status="${quote.effectiveStatus}"></mf-status-badge></div><button type="button" class="icon-button close-dialog" aria-label="${t("close")}">${icon("close")}</button></div>
      <div class="dialog-body">
        <dl class="detail-list">
          <dt>${t("client")}</dt><dd>${escapeHTML(clientName(clients, quote.clientId))}</dd>
          <dt>${t("issueDate")}</dt><dd>${formatDate(quote.issueDate)}</dd>
          <dt>${t("validUntil")}</dt><dd>${quote.validUntil ? formatDate(quote.validUntil) : "-"}</dd>
          <dt>${t("subtotal")}</dt><dd>${formatMoney(Number(quote.subtotalCents))}</dd>
          <dt>${t("taxAmount")}</dt><dd>${formatMoney(Number(quote.taxCents))}</dd>
          <dt>${t("total")}</dt><dd><strong>${formatMoney(Number(quote.totalCents))}</strong></dd>
          ${quote.notes ? `<dt>${t("notes")}</dt><dd>${escapeHTML(quote.notes)}</dd>` : ""}
          ${quote.project ? `<dt>${t("linkedProject")}</dt><dd><a href="#/projects">${escapeHTML(quote.project.name)}</a></dd>` : ""}
          ${
            obligation
              ? `<dt>${t("paymentDueDate")}</dt><dd>${formatDate(obligation.dueDate)} <mf-status-badge status="${obligation.paymentStatus}"></mf-status-badge></dd>
                 <dt>${t("collected")}</dt><dd>${formatMoney(Number(obligation.paidCents))}</dd>
                 <dt>${t("remaining")}</dt><dd>${formatMoney(Number(obligation.remainingCents))}</dd>`
              : ""
          }
        </dl>
        ${
          canWrite && open
            ? `<form id="accept-form" class="accept-panel" novalidate>
                <h3 class="card-title">${t("acceptQuote")}</h3>
                <p class="muted">${t("acceptHint")}</p>
                <div class="form-grid">
                  ${field("dueDate", t("paymentDueDate"), plusDays(30), "date")}
                  ${field("projectName", t("projectName"), escapeHTML(quote.number))}
                </div>
                <button class="button primary" type="submit">${icon("check")} ${t("acceptQuote")}</button>
              </form>`
            : ""
        }
        <h3 class="card-title">${t("history")}</h3>
        <ol class="activity-list">${quote.history
          .map(
            (entry) =>
              `<li class="activity-item"><div class="activity-copy"><strong>${escapeHTML(t(`audit.${entry.action}`))}</strong><span>${escapeHTML(entry.actorName || "-")} · ${formatDate(entry.createdAt)}</span></div></li>`,
          )
          .join("")}</ol>
        <p class="form-error" role="alert" id="detail-error"></p>
      </div>
      <div class="dialog-actions">${actions.join("")}<button type="button" class="button close-dialog">${t("close")}</button></div>`;
    dialog
      .querySelectorAll(".close-dialog")
      .forEach((button) => button.addEventListener("click", () => dialog.close()));
    dialog.querySelector("#edit-quote")?.addEventListener("click", () => {
      dialog.close();
      this.openForm(quote);
    });
    const fail = (error) => {
      dialog.querySelector("#detail-error").textContent = errorMessage(error);
    };
    dialog.querySelectorAll("[data-transition]").forEach((button) =>
      button.addEventListener("click", async () => {
        try {
          await quotesApi.update(quote.id, {
            version: quote.version,
            status: button.dataset.transition,
          });
          toast(t("saved"));
          await this.load();
          await this.openDetail(quote.id);
        } catch (error) {
          fail(error);
        }
      }),
    );
    const acceptKey = crypto.randomUUID();
    dialog.querySelector("#accept-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const submit = event.currentTarget.querySelector("button[type=submit]");
      submit.disabled = true;
      try {
        await quotesApi.accept(
          quote.id,
          {
            dueDate: values.dueDate,
            ...(values.projectName?.trim() ? { projectName: values.projectName.trim() } : {}),
          },
          acceptKey,
        );
        toast(t("accepted"));
        // The new project lives in the synced workspace; pull it so Projects shows it.
        void appStore.sync();
        await this.load();
        await this.openDetail(quote.id);
      } catch (error) {
        submit.disabled = false;
        fail(error);
      }
    });
  }
}

function field(name, label, value, type = "text", extra = "") {
  return `<div class="form-group"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${value}" ${extra}><span class="field-error" id="${name}-error"></span></div>`;
}

customElements.define("mf-quotes-view", MFQuotesView);
export const tag = "mf-quotes-view";
