import { appStore } from "../../core/store.js";
import { t } from "../../core/i18n.js";
import { escapeHTML } from "../../core/security.js";
import { icon } from "../../design-system/icons.js";
import { pageHeader } from "../shared.js";

const permissions = [
  ["Owner", "CRM · Finance · Projects · Team · Settings"],
  ["Project Manager", "CRM read · Projects manage · Reports read"],
  ["Finance", "Finance manage · Reports manage · CRM read"],
  ["Developer", "Projects update · CRM read"],
  ["Designer", "Projects update · CRM read"],
];

class MFTeamView extends HTMLElement {
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
    const { employees, tasks } = appStore.state.data;
    this.innerHTML = `<section class="page" aria-labelledby="team-title">
      ${pageHeader({
        eyebrow: "PEOPLE",
        title: t("team"),
        subtitle: `${employees.length} collaborateurs · contrôle d’accès local`,
        actions: `<button class="button primary" disabled title="Portfolio demo">${icon("plus")} Inviter</button>`,
      }).replace('class="page-title"', 'class="page-title" id="team-title"')}

      <div class="stats-grid">
        <mf-stat-card data-label="Collaborateurs" data-value="${employees.length}" data-meta="${employees.filter((e) => e.status === "active").length} ${t("active").toLowerCase()}" data-icon="users" data-tone="emerald"></mf-stat-card>
        <mf-stat-card data-label="Tâches ouvertes" data-value="${tasks.filter((task) => task.status !== "done").length}" data-meta="${tasks.filter((task) => task.status === "done").length} ${t("done").toLowerCase()}" data-icon="projects" data-tone="blue"></mf-stat-card>
        <mf-stat-card data-label="Départements" data-value="${new Set(employees.map((e) => e.department)).size}" data-meta="Cross-functional" data-icon="building" data-tone="saffron"></mf-stat-card>
        <mf-stat-card data-label="Disponibilité" data-value="96%" data-meta="Cette semaine" data-icon="check" data-tone="clay"></mf-stat-card>
      </div>

      <div class="content-grid">
        <article class="table-shell">
          <table>
            <thead><tr><th>${t("name")}</th><th>Département</th><th>${t("role")}</th><th>${t("status")}</th></tr></thead>
            <tbody>${employees
              .map(
                (employee) => `<tr>
                  <td><div class="person-cell"><mf-avatar name="${escapeHTML(employee.name)}"></mf-avatar><div><strong>${escapeHTML(employee.name)}</strong><span>${escapeHTML(employee.email)}</span></div></div></td>
                  <td>${escapeHTML(employee.department)}</td>
                  <td>${escapeHTML(employee.role)}</td>
                  <td><mf-status-badge status="${employee.status}"></mf-status-badge></td>
                </tr>`,
              )
              .join("")}</tbody>
          </table>
        </article>
        <article class="card">
          <div class="card-header"><h2 class="card-title">${t("roleAccess")}</h2><span class="badge">${icon("lock")} Local demo</span></div>
          <div class="activity-list">
            ${permissions.map(([role, access]) => `<div class="activity-item"><span class="activity-icon">${icon("team")}</span><div class="activity-copy"><strong>${role}</strong><span>${access}</span></div></div>`).join("")}
          </div>
        </article>
      </div>
      <p class="footer-credit">UI permissions are demonstrative; server-side enforcement is required in production.</p>
    </section>`;
  }
}

customElements.define("mf-team-view", MFTeamView);
export const tag = "mf-team-view";
