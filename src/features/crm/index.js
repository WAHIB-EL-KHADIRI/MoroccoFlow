import { appStore } from "../../core/store.js";
import { t } from "../../core/i18n.js";
import { escapeHTML } from "../../core/security.js";
import { formatMoney } from "../../shared/formatters.js";
import { validateClient } from "../../shared/validation.js";
import { icon } from "../../design-system/icons.js";
import { toast } from "../../design-system/components.js";
import { pageHeader, emptyState, downloadCsv } from "../shared.js";

class MFCRMView extends HTMLElement {
  query = "";

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
    const { clients, deals } = appStore.state.data;
    const filtered = clients.filter((client) =>
      `${client.name} ${client.company} ${client.city}`
        .toLowerCase()
        .includes(this.query.toLowerCase()),
    );
    const stageLabels = {
      contact: "Contact",
      qualified: "Qualifié",
      proposal: "Proposition",
      won: "Gagné",
    };
    const stageValues = ["contact", "qualified", "proposal", "won"].map((stage) => ({
      stage,
      count: deals.filter((deal) => deal.stage === stage).length,
      amount: deals
        .filter((deal) => deal.stage === stage)
        .reduce((sum, deal) => sum + deal.amount, 0),
    }));

    this.innerHTML = `<section class="page" aria-labelledby="crm-title">
      ${pageHeader({
        eyebrow: "CRM",
        title: t("allClients"),
        subtitle: `${clients.length} ${t("clients").toLowerCase()} · ${deals.length} opportunités`,
        actions: `<button class="button primary" id="add-client">${icon("plus")} ${t("addClient")}</button>`,
      }).replace('class="page-title"', 'class="page-title" id="crm-title"')}

      <div class="stats-grid">
        ${stageValues
          .map(
            ({ stage, count, amount }, index) =>
              `<mf-stat-card data-label="${stageLabels[stage]}" data-value="${formatMoney(amount)}" data-meta="${count} opportunité${count > 1 ? "s" : ""}" data-icon="trend" data-tone="${["blue", "saffron", "clay", "emerald"][index]}"></mf-stat-card>`,
          )
          .join("")}
      </div>

      <div class="toolbar">
        <label class="sr-only" for="client-search">${t("search")}</label>
        <input class="field" id="client-search" type="search" placeholder="${t("search")}" value="${escapeHTML(this.query)}">
        <select class="select" id="client-status" aria-label="${t("status")}">
          <option value="">${t("status")} · Tous</option>
          <option value="active">${t("active")}</option>
          <option value="prospect">${t("prospect")}</option>
        </select>
        <span class="toolbar-spacer"></span>
        <button class="button" id="export-clients">${icon("download")} ${t("exportCsv")}</button>
      </div>

      ${
        filtered.length
          ? `<div class="table-shell">
            <table>
              <thead><tr><th>${t("client")}</th><th>${t("city")}</th><th>${t("phone")}</th><th>${t("status")}</th><th><span class="sr-only">${t("actions")}</span></th></tr></thead>
              <tbody>
                ${filtered
                  .map(
                    (client) => `<tr>
                      <td><div class="person-cell"><mf-avatar name="${escapeHTML(client.name)}"></mf-avatar><div><strong>${escapeHTML(client.company)}</strong><span>${escapeHTML(client.name)} · ${escapeHTML(client.email)}</span></div></div></td>
                      <td>${escapeHTML(client.city)}</td>
                      <td dir="ltr">${escapeHTML(client.phone)}</td>
                      <td><mf-status-badge status="${client.status}"></mf-status-badge></td>
                      <td class="text-end"><button class="button ghost small delete-client" data-id="${client.id}" aria-label="${t("delete")} ${escapeHTML(client.company)}">${t("delete")}</button></td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`
          : emptyState(
              `<button class="button primary" id="empty-add-client">${t("addClient")}</button>`,
            )
      }

      <dialog id="client-dialog" aria-labelledby="client-dialog-title">
        <form id="client-form" novalidate>
          <div class="dialog-head"><h2 class="dialog-title" id="client-dialog-title">${t("addClient")}</h2><button type="button" class="icon-button close-dialog" aria-label="${t("close")}">${icon("close")}</button></div>
          <div class="dialog-body form-grid">
            ${this.formField("name", t("name"), "Salma Bennani")}
            ${this.formField("company", t("company"), "Atlas Studio")}
            ${this.formField("email", t("email"), "contact@atlas.demo", "email")}
            ${this.formField("phone", t("phone"), "+212 661 23 45 67", "tel")}
            ${this.formField("city", t("city"), "Casablanca")}
            <div class="form-group"><label for="status">${t("status")}</label><select id="status" name="status"><option value="active">${t("active")}</option><option value="prospect">${t("prospect")}</option></select></div>
          </div>
          <div class="dialog-actions"><button type="button" class="button close-dialog">${t("cancel")}</button><button type="submit" class="button primary">${t("save")}</button></div>
        </form>
      </dialog>
    </section>`;

    this.bindEvents();
  }

  formField(name, label, placeholder, type = "text") {
    return `<div class="form-group"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" placeholder="${placeholder}" required><span class="field-error" id="${name}-error"></span></div>`;
  }

  bindEvents() {
    const dialog = this.querySelector("#client-dialog");
    const open = () => dialog.showModal();
    this.querySelector("#add-client")?.addEventListener("click", open);
    this.querySelector("#empty-add-client")?.addEventListener("click", open);
    this.querySelectorAll(".close-dialog").forEach((button) =>
      button.addEventListener("click", () => dialog.close()),
    );
    this.querySelector("#client-search")?.addEventListener("input", (event) => {
      this.query = event.target.value;
      this.render();
      const input = this.querySelector("#client-search");
      input.focus();
      input.setSelectionRange(this.query.length, this.query.length);
    });
    this.querySelector("#client-status")?.addEventListener("change", (event) => {
      this.query = event.target.value;
      this.render();
    });
    this.querySelector("#export-clients")?.addEventListener("click", () => {
      const clients = appStore.state.data.clients;
      downloadCsv(
        "moroccoflow-clients.csv",
        ["Name", "Company", "City", "Email", "Phone", "Status"],
        clients.map((item) => [
          item.name,
          item.company,
          item.city,
          item.email,
          item.phone,
          item.status,
        ]),
      );
    });
    this.querySelectorAll(".delete-client").forEach((button) =>
      button.addEventListener("click", async () => {
        if (window.confirm(`${t("delete")} ?`)) {
          await appStore.delete("clients", button.dataset.id);
          toast(t("saved"));
        }
      }),
    );
    this.querySelector("#client-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      const errors = validateClient(values);
      this.querySelectorAll(".field-error").forEach((node) => (node.textContent = ""));
      this.querySelectorAll("[aria-invalid]").forEach((node) =>
        node.removeAttribute("aria-invalid"),
      );
      if (Object.keys(errors).length) {
        for (const [field, message] of Object.entries(errors)) {
          const input = this.querySelector(`#${field}`);
          input?.setAttribute("aria-invalid", "true");
          this.querySelector(`#${field}-error`).textContent = message;
        }
        this.querySelector(`#${Object.keys(errors)[0]}`)?.focus();
        return;
      }
      await appStore.save("clients", values);
      dialog.close();
      toast(t("saved"));
    });
  }
}

customElements.define("mf-crm-view", MFCRMView);
export const tag = "mf-crm-view";
