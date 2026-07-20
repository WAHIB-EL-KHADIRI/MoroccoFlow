import { appStore } from "../../core/store.js";
import { t, getLocale } from "../../core/i18n.js";
import { formatMoney, formatDate } from "../../shared/formatters.js";
import { escapeHTML } from "../../core/security.js";
import { icon } from "../../design-system/icons.js";
import { pageHeader, clientName } from "../shared.js";

class MFDashboardView extends HTMLElement {
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
    const { invoices, expenses, projects, clients } = appStore.state.data;
    const revenue = invoices
      .filter((item) => item.status === "paid")
      .reduce((s, i) => s + i.amount, 0);
    const spending = expenses.reduce((sum, item) => sum + item.amount, 0);
    const outstanding = invoices
      .filter((item) => ["pending", "overdue"].includes(item.status))
      .reduce((sum, item) => sum + item.amount, 0);
    const active = projects.filter((project) => project.status === "active");
    const labels =
      getLocale() === "ar"
        ? ["يناير", "فبراير", "مارس", "أبريل", "ماي", "يونيو"]
        : ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin"];
    const values = [0, 0, 0, 0, 0, 0];

    const markup = `<section class="page" aria-labelledby="dashboard-title">
      ${pageHeader({
        eyebrow: "20 JUL 2026",
        title: t("welcome"),
        subtitle: t("welcomeHint"),
        actions: `<a class="button primary" href="#/finance?action=new-invoice">${icon("plus")} ${t("addInvoice")}</a>`,
      }).replace('class="page-title"', 'class="page-title" id="dashboard-title"')}

      <div class="stats-grid">
        <mf-stat-card data-label="${t("revenue")}" data-value="${formatMoney(revenue)}" data-meta="↗ 12.4% · ${t("thisYear")}" data-icon="trend" data-tone="emerald"></mf-stat-card>
        <mf-stat-card data-label="${t("expenses")}" data-value="${formatMoney(spending)}" data-meta="↘ 4.2% · ${t("thisYear")}" data-icon="wallet" data-tone="clay" data-negative="true"></mf-stat-card>
        <mf-stat-card data-label="${t("outstanding")}" data-value="${formatMoney(outstanding)}" data-meta="${invoices.filter((i) => ["pending", "overdue"].includes(i.status)).length} ${t("invoices").toLowerCase()}" data-icon="clock" data-tone="saffron"></mf-stat-card>
        <mf-stat-card data-label="${t("activeProjects")}" data-value="${active.length}" data-meta="${projects.filter((p) => p.status === "done").length} ${t("done").toLowerCase()}" data-icon="projects" data-tone="blue"></mf-stat-card>
      </div>

      <div class="content-grid">
        <article class="card">
          <div class="card-header">
            <div>
              <h2 class="card-title">${t("performance")}</h2>
              <span class="muted">${t("revenue")} · MAD</span>
            </div>
            <span class="badge">${t("thisYear")}</span>
          </div>
          <div class="card-body chart-wrap">
            <mf-chart data-label="${t("performance")}" data-labels='${JSON.stringify(labels)}' data-values='${JSON.stringify(values)}' data-series="${t("revenue")}"></mf-chart>
          </div>
        </article>
        <article class="card">
          <div class="card-header">
            <h2 class="card-title">${t("activeProjects")}</h2>
            <a class="button ghost small" href="#/projects">${t("viewAll")}</a>
          </div>
          <div class="card-body">
            ${active
              .map(
                (project) => `<div class="progress-row">
                  <div class="progress-meta">
                    <span>${escapeHTML(project.name)}</span><span>${project.progress}%</span>
                  </div>
                  <div class="progress-track"><div class="progress-value" style="width:${project.progress}%"></div></div>
                  <span class="muted">${escapeHTML(clientName(clients, project.clientId))} · ${formatDate(project.dueDate)}</span>
                </div>`,
              )
              .join("")}
          </div>
        </article>
      </div>

      <div class="content-grid">
        <article class="card">
          <div class="card-header">
            <h2 class="card-title">${t("recentActivity")}</h2>
            <a class="button ghost small" href="#/finance">${t("viewAll")}</a>
          </div>
          <div class="activity-list">
            ${invoices
              .slice()
              .sort((a, b) => new Date(b.date) - new Date(a.date))
              .slice(0, 4)
              .map(
                (invoice) => `<div class="activity-item">
                  <span class="activity-icon">${icon(invoice.status === "paid" ? "check" : "finance")}</span>
                  <div class="activity-copy">
                    <strong>${escapeHTML(invoice.number)} · ${escapeHTML(clientName(clients, invoice.clientId))}</strong>
                    <span>${formatMoney(invoice.amount)}</span>
                  </div>
                  <mf-status-badge status="${invoice.status}"></mf-status-badge>
                </div>`,
              )
              .join("")}
          </div>
        </article>
        <article class="metric-callout">
          <span>${t("profit")}</span>
          <strong>${formatMoney(revenue - spending)}</strong>
          <p style="margin-top:8px;opacity:.68">${t("localFirst")}</p>
        </article>
      </div>
      <p class="footer-credit">Designed & built by WAHIB EL KHADIRI · MoroccoFlow 2026</p>
    </section>`;
    const marker = '<div class="content-grid">';
    const firstGrid = markup.indexOf(marker);
    const secondGrid = markup.indexOf(marker, firstGrid + marker.length);
    const contentEnd = markup.lastIndexOf("</section>");
    this.innerHTML = `${markup.slice(0, firstGrid)}</section>`;
    const section = this.firstElementChild;
    setTimeout(() => {
      if (section?.isConnected) {
        section.insertAdjacentHTML("beforeend", markup.slice(firstGrid, secondGrid));
      }
    }, 0);
    setTimeout(() => {
      if (section?.isConnected) {
        section.insertAdjacentHTML("beforeend", markup.slice(secondGrid, contentEnd));
      }
    }, 60);
  }
}

customElements.define("mf-dashboard-view", MFDashboardView);
export const tag = "mf-dashboard-view";
