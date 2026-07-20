import { appStore } from "../../core/store.js";
import { seedDatabase } from "../../core/database.js";
import { getLocale, setLocale, t } from "../../core/i18n.js";
import { escapeHTML } from "../../core/security.js";
import { icon } from "../../design-system/icons.js";
import { toast } from "../../design-system/components.js";
import { pageHeader, downloadBlob } from "../shared.js";

class MFSettingsView extends HTMLElement {
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
    const company = appStore.state.data.settings.find((item) => item.id === "company") || {};
    const theme = document.documentElement.dataset.theme || "light";
    this.innerHTML = `<section class="page" aria-labelledby="settings-title">
      ${pageHeader({
        eyebrow: "WORKSPACE",
        title: t("settings"),
        subtitle: t("localFirst"),
      }).replace('class="page-title"', 'class="page-title" id="settings-title"')}

      <div class="settings-grid">
        <div style="display:grid;gap:18px">
          <article class="card">
            <div class="card-header"><h2 class="card-title">${t("companySettings")}</h2><span class="badge">SARL · MAD</span></div>
            <form class="card-body form-grid" id="company-form">
              ${this.field("name", t("name"), company.name)}
              ${this.field("legalName", "Raison sociale", company.legalName)}
              ${this.field("ice", "ICE", company.ice, "text", "15")}
              ${this.field("city", t("city"), company.city)}
              <div class="form-group full"><button class="button primary" type="submit">${t("save")}</button></div>
            </form>
          </article>
          <article class="card">
            <div class="card-header"><h2 class="card-title">${t("data")}</h2><span class="badge">${icon("lock")} IndexedDB</span></div>
            <div class="card-body">
              <p class="muted" style="margin-bottom:16px">Vos données restent dans ce navigateur. Exportez une sauvegarde avant de changer d’appareil.</p>
              <div class="button-row"><button class="button" id="backup">${icon("download")} ${t("downloadBackup")}</button><button class="button danger" id="reset">${icon("refresh")} ${t("resetDemo")}</button></div>
            </div>
          </article>
        </div>

        <div style="display:grid;align-content:start;gap:18px">
          <article class="card">
            <div class="card-header"><h2 class="card-title">${t("language")}</h2></div>
            <div class="card-body"><div class="segmented" aria-label="${t("language")}">
              <button data-locale="fr" aria-pressed="${getLocale() === "fr"}">Français</button>
              <button data-locale="ar" aria-pressed="${getLocale() === "ar"}">العربية</button>
            </div></div>
          </article>
          <article class="card">
            <div class="card-header"><h2 class="card-title">${t("appearance")}</h2></div>
            <div class="card-body"><div class="segmented" aria-label="${t("appearance")}">
              <button data-theme="light" aria-pressed="${theme === "light"}">${t("light")}</button>
              <button data-theme="dark" aria-pressed="${theme === "dark"}">${t("dark")}</button>
            </div></div>
          </article>
          <article class="privacy-card">
            <strong>${icon("lock")} ${t("localFirst")}</strong>
            IndexedDB · Offline cache · no analytics · no external API
          </article>
        </div>
      </div>
      <p class="footer-credit">MoroccoFlow v1.0 · WAHIB EL KHADIRI</p>
    </section>`;
    this.bindEvents();
  }

  field(name, label, value = "", type = "text", maxlength = "") {
    return `<div class="form-group"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" value="${escapeHTML(value)}" ${maxlength ? `maxlength="${maxlength}" pattern="\\d{15}"` : ""} required></div>`;
  }

  bindEvents() {
    this.querySelectorAll("[data-locale]").forEach((button) =>
      button.addEventListener("click", () => setLocale(button.dataset.locale)),
    );
    this.querySelectorAll("[data-theme]").forEach((button) =>
      button.addEventListener("click", () => {
        document.documentElement.dataset.theme = button.dataset.theme;
        localStorage.setItem("mf-theme", button.dataset.theme);
        this.render();
      }),
    );
    this.querySelector("#company-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      await appStore.save("settings", { id: "company", ...values, currency: "MAD" });
      toast(t("saved"));
    });
    this.querySelector("#backup")?.addEventListener("click", async () => {
      const data = await appStore.exportData();
      downloadBlob(
        `moroccoflow-backup-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data }, null, 2),
        "application/json",
      );
    });
    this.querySelector("#reset")?.addEventListener("click", async () => {
      if (!window.confirm(`${t("resetDemo")} ?`)) return;
      await seedDatabase(true);
      await appStore.reload();
      toast(t("saved"));
    });
  }
}

customElements.define("mf-settings-view", MFSettingsView);
export const tag = "mf-settings-view";
