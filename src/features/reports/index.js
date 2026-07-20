import { appStore } from "../../core/store.js";
import { t, getLocale } from "../../core/i18n.js";
import { formatMoney } from "../../shared/formatters.js";
import { icon } from "../../design-system/icons.js";
import { pageHeader, downloadCsv, clientName } from "../shared.js";

class MFReportsView extends HTMLElement {
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
    const { invoices, expenses, clients, projects, tasks } = appStore.state.data;
    const revenue = invoices
      .filter((item) => item.status === "paid")
      .reduce((sum, item) => sum + item.amount, 0);
    const spending = expenses.reduce((sum, item) => sum + item.amount, 0);
    const outstanding = invoices
      .filter((item) => ["pending", "overdue"].includes(item.status))
      .reduce((sum, item) => sum + item.amount, 0);
    const margin = revenue ? ((revenue - spending) / revenue) * 100 : 0;
    const labels =
      getLocale() === "ar"
        ? ["يناير", "فبراير", "مارس", "أبريل", "ماي", "يونيو"]
        : ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin"];
    const cash = [0, 0, 0, 0, 0, 0];
    const statuses = [
      invoices.filter((i) => i.status === "paid").reduce((sum, i) => sum + i.amount / 100, 0),
      invoices.filter((i) => i.status === "pending").reduce((sum, i) => sum + i.amount / 100, 0),
      invoices.filter((i) => i.status === "overdue").reduce((sum, i) => sum + i.amount / 100, 0),
      invoices.filter((i) => i.status === "draft").reduce((sum, i) => sum + i.amount / 100, 0),
    ];

    this.innerHTML = `<section class="page" aria-labelledby="reports-title">
      ${pageHeader({
        eyebrow: "INSIGHTS",
        title: t("reports"),
        subtitle: "Une lecture claire de la santé de votre activité.",
        actions: `<button class="button" id="export-report">${icon("download")} ${t("exportCsv")}</button><button class="button primary" id="print-report">${icon("download")} ${t("exportPdf")}</button>`,
      }).replace('class="page-title"', 'class="page-title" id="reports-title"')}

      <div class="stats-grid">
        <mf-stat-card data-label="${t("revenue")}" data-value="${formatMoney(revenue)}" data-meta="↗ 12.4%" data-icon="trend" data-tone="emerald"></mf-stat-card>
        <mf-stat-card data-label="${t("profit")}" data-value="${formatMoney(revenue - spending)}" data-meta="${margin.toFixed(1)}% marge" data-icon="wallet" data-tone="blue"></mf-stat-card>
        <mf-stat-card data-label="${t("outstanding")}" data-value="${formatMoney(outstanding)}" data-meta="${invoices.filter((i) => i.status === "overdue").length} ${t("overdue").toLowerCase()}" data-icon="clock" data-tone="saffron"></mf-stat-card>
        <mf-stat-card data-label="${t("activeProjects")}" data-value="${projects.filter((p) => p.status === "active").length}" data-meta="${tasks.filter((task) => task.status === "done").length}/${tasks.length} tâches" data-icon="projects" data-tone="clay"></mf-stat-card>
      </div>

      <div class="report-grid">
        <article class="card">
          <div class="card-header"><h2 class="card-title">${t("cashflow")}</h2><span class="badge">6 mois</span></div>
          <div class="card-body chart-wrap"><mf-chart data-label="${t("cashflow")}" data-labels='${JSON.stringify(labels)}' data-values='${JSON.stringify(cash)}' data-series="${t("cashflow")}"></mf-chart></div>
        </article>
        <article class="card">
          <div class="card-header"><h2 class="card-title">${t("invoices")} · ${t("status")}</h2><span class="badge">MAD</span></div>
          <div class="card-body chart-wrap"><mf-chart data-type="doughnut" data-label="${t("invoices")}" data-labels='${JSON.stringify(["Paid", "Pending", "Overdue", "Draft"])}' data-values='${JSON.stringify(statuses)}'></mf-chart></div>
        </article>
      </div>

      <div class="content-grid">
        <article class="metric-callout"><span>${t("profit")}</span><strong>${formatMoney(revenue - spending)}</strong><p style="margin-top:8px;opacity:.68">${margin.toFixed(1)}% de marge nette</p></article>
        <article class="card"><div class="card-header"><h2 class="card-title">Top clients</h2></div><div class="activity-list">
          ${invoices
            .slice()
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 3)
            .map(
              (invoice, index) =>
                `<div class="activity-item"><span class="count">${index + 1}</span><div class="activity-copy"><strong>${clientName(clients, invoice.clientId)}</strong><span>${invoice.number}</span></div><strong>${formatMoney(invoice.amount)}</strong></div>`,
            )
            .join("")}
        </div></article>
      </div>
    </section>`;
    this.querySelector("#print-report")?.addEventListener("click", () => window.print());
    this.querySelector("#export-report")?.addEventListener("click", () =>
      downloadCsv(
        "moroccoflow-report.csv",
        ["Metric", "Value MAD"],
        [
          ["Revenue", revenue / 100],
          ["Expenses", spending / 100],
          ["Net profit", (revenue - spending) / 100],
          ["Outstanding", outstanding / 100],
        ],
      ),
    );
  }
}

customElements.define("mf-reports-view", MFReportsView);
export const tag = "mf-reports-view";
