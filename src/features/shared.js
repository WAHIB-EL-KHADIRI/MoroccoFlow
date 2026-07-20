import { t } from "../core/i18n.js";
import { escapeHTML, csvCell } from "../core/security.js";
import { icon } from "../design-system/icons.js";

export function pageHeader({ eyebrow = "MoroccoFlow", title, subtitle, actions = "" }) {
  return `<header class="page-header">
    <div>
      <div class="eyebrow">${escapeHTML(eyebrow)}</div>
      <h1 class="page-title">${escapeHTML(title)}</h1>
      ${subtitle ? `<p class="page-subtitle">${escapeHTML(subtitle)}</p>` : ""}
    </div>
    ${actions ? `<div class="button-row">${actions}</div>` : ""}
  </header>`;
}

export function emptyState(action = "") {
  return `<div class="state-panel">
    <div>
      <span class="state-icon">${icon("projects")}</span>
      <h2 class="card-title">${t("empty")}</h2>
      <p>${t("emptyHint")}</p>
      ${action}
    </div>
  </div>`;
}

export const clientName = (clients, id) =>
  clients.find((client) => client.id === id)?.company || "—";

export const employeeName = (employees, id) =>
  employees.find((employee) => employee.id === id)?.name || "—";

export function downloadCsv(filename, headers, rows) {
  const content = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  downloadBlob(filename, `\uFEFF${content}`, "text/csv;charset=utf-8");
}

export function downloadBlob(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
