import { appStore } from "../core/store.js";
import { initLocale, setLocale, getLocale, t } from "../core/i18n.js";
import { escapeHTML } from "../core/security.js";
import { formatDate } from "../shared/formatters.js";
import { icon, flowMark } from "../design-system/icons.js";
import { toast } from "../design-system/components.js";

const routes = {
  dashboard: () => import("../features/dashboard/index.js"),
  crm: () => import("../features/crm/index.js"),
  quotes: () => import("../features/quotes/index.js"),
  projects: () => import("../features/projects/index.js"),
  finance: () => import("../features/finance/index.js"),
  reports: () => import("../features/reports/index.js"),
  team: () => import("../features/team/index.js"),
  settings: () => import("../features/settings/index.js"),
};

const navItems = [
  ["dashboard", "dashboard"],
  ["crm", "users"],
  ["quotes", "check"],
  ["projects", "projects"],
  ["finance", "finance"],
  ["reports", "reports"],
  ["team", "team"],
  ["settings", "settings"],
];

const routePermissions = {
  crm: "crm:read",
  quotes: "quotes:read",
  projects: "projects:read",
  finance: "finance:read",
  reports: "reports:read",
  team: "team:read",
  settings: "settings:read",
};

function hasGrant(user, permission) {
  if (!permission || !user) return true;
  const grants = user.permissions || [];
  return (
    grants.includes("*") ||
    grants.includes(permission) ||
    grants.includes(`${permission.split(":")[0]}:*`)
  );
}
class MoroccoFlowApp extends HTMLElement {
  mobileOpen = false;

  async connectedCallback() {
    initLocale();
    this.initTheme();
    this.unsubscribe = appStore.subscribe((state) => this.onState(state));
    this.onHashChange = () => this.navigate();
    this.onLocaleChange = () => this.renderShell();
    this.onConnectivity = () => {
      this.updateConnectivity();
      if (navigator.onLine && appStore.state.mode === "company") appStore.sync();
    };
    window.addEventListener("hashchange", this.onHashChange);
    window.addEventListener("mf:locale-change", this.onLocaleChange);
    window.addEventListener("online", this.onConnectivity);
    window.addEventListener("offline", this.onConnectivity);
    window.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        this.querySelector("#global-search")?.focus();
      }
    });
    this.renderLoading();
    await appStore.init();
  }

  disconnectedCallback() {
    this.unsubscribe?.();
    window.removeEventListener("hashchange", this.onHashChange);
    window.removeEventListener("mf:locale-change", this.onLocaleChange);
    window.removeEventListener("online", this.onConnectivity);
    window.removeEventListener("offline", this.onConnectivity);
  }

  initTheme() {
    const saved = localStorage.getItem("mf-theme");
    const preferred = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = saved || preferred;
  }

  onState(state) {
    if (state.loading) return;
    if (state.needsAuth) {
      this.renderLogin();
      return;
    }
    if (state.error) {
      this.renderError(state.error);
      return;
    }
    if (!this.querySelector(".app-layout")) this.renderShell();
    this.updateNotificationDot();
    this.updateConnectivity(false);
  }

  visibleNavItems() {
    if (appStore.state.mode !== "company") return navItems;
    return navItems.filter(
      ([route]) => route === "dashboard" || hasGrant(appStore.state.user, routePermissions[route]),
    );
  }
  currentRoute() {
    const value = location.hash.replace(/^#\/?/, "").split("?")[0];
    const visible = this.visibleNavItems().map(([route]) => route);
    return routes[value] && visible.includes(value) ? value : visible[0] || "dashboard";
  }

  async navigate() {
    if (appStore.state.loading || appStore.state.error) return;
    const route = this.currentRoute();
    appStore.setRoute(route);
    this.mobileOpen = false;
    this.updateMobileMenu();
    this.querySelectorAll(".nav-link").forEach((link) =>
      link.toggleAttribute("aria-current", link.dataset.route === route),
    );
    const outlet = this.querySelector("#main-content");
    if (!outlet) return;
    outlet.innerHTML = '<div class="page"><div class="skeleton" style="height:180px"></div></div>';
    try {
      const module = await routes[route]();
      const view = document.createElement(module.tag);
      outlet.replaceChildren(view);
      document.title = `${t(route)} · MoroccoFlow`;
      this.querySelector(".topbar")?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "instant" });
    } catch (error) {
      outlet.innerHTML = `<div class="page state-panel"><div><span class="state-icon">${icon("alert")}</span><h1>${t("error")}</h1><p>${escapeHTML(error.message)}</p><button class="button primary" onclick="location.reload()">${t("retry")}</button></div></div>`;
    }
  }

  renderLogin() {
    const arabic = getLocale() === "ar";
    document.documentElement.lang = arabic ? "ar" : "fr";
    document.documentElement.dir = arabic ? "rtl" : "ltr";
    this.innerHTML = `<main class="auth-screen">
      <section class="auth-card" aria-labelledby="login-title">
        <a class="brand auth-brand" href="#" aria-label="MoroccoFlow"><span class="brand-mark">${flowMark()}</span><span>MoroccoFlow</span></a>
        <div>
          <p class="eyebrow">SECURE WORKSPACE</p>
          <h1 id="login-title">${arabic ? "الدخول إلى مساحة الشركة" : "Connexion à votre espace"}</h1>
          <p class="muted">${arabic ? "بياناتك معزولة ومشفرة أثناء النقل." : "Vos données sont isolées et chiffrées en transit."}</p>
        </div>
        <form id="login-form" class="auth-form">
          <div class="form-group"><label for="workspace">${arabic ? "معرّف الشركة" : "Espace entreprise"}</label><input id="workspace" name="workspace" required minlength="3" maxlength="63" pattern="[a-z0-9][a-z0-9-]+" autocomplete="organization" placeholder="moroccoflow"></div>
          <div class="form-group"><label for="login-email">${t("email")}</label><input id="login-email" name="email" type="email" required autocomplete="username"></div>
          <div class="form-group"><label for="login-password">${arabic ? "كلمة المرور" : "Mot de passe"}</label><input id="login-password" name="password" type="password" required autocomplete="current-password"></div>
          <div class="form-group"><label for="mfa-code">${arabic ? "رمز التحقق (إن كان مفعّلًا)" : "Code MFA (si activé)"}</label><input id="mfa-code" name="mfaCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"></div>
          <p id="login-error" class="field-error" role="alert"></p>
          <button class="button primary auth-submit" type="submit">${arabic ? "دخول آمن" : "Connexion sécurisée"}</button>
        </form>
        <button class="button ghost" id="login-language" type="button">${arabic ? "Français" : "العربية"}</button>
        <p class="footer-credit">MoroccoFlow · WAHIB EL KHADIRI</p>
      </section>
    </main>`;
    this.querySelector("#login-language")?.addEventListener("click", () => {
      setLocale(arabic ? "fr" : "ar");
      this.renderLogin();
    });
    this.querySelector("#login-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector("button[type='submit']");
      const errorNode = this.querySelector("#login-error");
      button.disabled = true;
      errorNode.textContent = "";
      try {
        await appStore.login(Object.fromEntries(new FormData(event.currentTarget)));
      } catch (error) {
        errorNode.textContent = error.message;
        button.disabled = false;
      }
    });
  }
  renderLoading() {
    this.innerHTML = `<div class="page" aria-busy="true" aria-label="${t("loading")}">
      <div style="display:grid;grid-template-columns:220px 1fr;gap:22px">
        <div class="skeleton" style="height:90vh"></div>
        <div><div class="skeleton" style="height:72px;margin-bottom:24px"></div><div class="stats-grid">${Array(4).fill('<div class="skeleton" style="height:140px"></div>').join("")}</div></div>
      </div>
    </div>`;
  }

  renderError(message) {
    this.innerHTML = `<div class="state-panel"><div><span class="state-icon">${icon("alert")}</span><h1>${t("error")}</h1><p>${escapeHTML(message)}</p><button class="button primary" id="retry-app">${t("retry")}</button></div></div>`;
    this.querySelector("#retry-app").addEventListener("click", () => location.reload());
  }

  renderShell() {
    const route = this.currentRoute();
    const unread = appStore.state.data.notifications.filter((item) => !item.read).length;
    const companyMode = appStore.state.mode === "company";
    const userName = appStore.state.user?.fullName || "Wahib El Khadiri";
    this.innerHTML = `<div class="app-layout">
      <aside class="sidebar ${this.mobileOpen ? "open" : ""}" aria-label="Primary navigation">
        <a class="brand" href="#/dashboard" aria-label="MoroccoFlow home"><span class="brand-mark">${flowMark()}</span><span>MoroccoFlow</span></a>
        <div class="nav-section-label">Workspace</div>
        <nav class="main-nav">
          ${this.visibleNavItems()
            .map(
              ([name, iconName]) =>
                `<a class="nav-link" href="#/${name}" data-route="${name}" ${route === name ? 'aria-current="page"' : ""}>${icon(iconName, "nav-icon")}<span>${t(name)}</span></a>`,
            )
            .join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="privacy-card"><strong>${icon("lock")} ${companyMode ? "API + RLS" : t("localFirst")}</strong>${companyMode ? "Encrypted sync · Offline queue" : "IndexedDB · PWA · Offline"}</div>
        </div>
      </aside>
      ${this.mobileOpen ? '<button class="mobile-overlay" aria-label="Close navigation"></button>' : ""}
      <div class="app-main">
        <header class="topbar" tabindex="-1">
          <button class="icon-button mobile-menu" id="mobile-menu" aria-label="Open navigation" aria-expanded="${this.mobileOpen}">${icon("menu")}</button>
          <label class="search-box">
            <span class="sr-only">${t("search")}</span>
            ${icon("search")}
            <input id="global-search" type="search" placeholder="${t("search")}" autocomplete="off">
          </label>
          <div class="topbar-actions">
            ${companyMode && !hasGrant(appStore.state.user, "finance:write") ? "" : `<button class="button primary" id="quick-create">${icon("plus")} ${t("newAction")}</button>`}
            <button class="icon-button" id="language-toggle" aria-label="${t("language")} ${getLocale() === "ar" ? "FR" : "AR"}">${getLocale() === "ar" ? "FR" : "AR"}</button>
            <button class="icon-button" id="theme-toggle" aria-label="${t("appearance")}">${icon("moon")}</button>
            <button class="icon-button" id="notifications-button" aria-label="${t("notifications")}">${icon("bell")}${unread ? '<span class="notification-dot"></span>' : ""}</button>
            <button class="avatar-button" ${companyMode ? 'id="logout-button"' : ""} aria-label="${companyMode ? `Sign out - ${escapeHTML(userName)}` : `WE - ${escapeHTML(userName)}`}"><mf-avatar name="${escapeHTML(userName)}"></mf-avatar></button>
          </div>
        </header>
        <main id="main-content"></main>
      </div>
    </div>
    <div class="toast-region" aria-live="polite" aria-atomic="true"></div>
    <div id="connectivity-region" aria-live="polite"></div>
    ${this.notificationDialog()}`;
    this.bindShellEvents();
    this.navigate();
    this.updateConnectivity(false);
  }

  notificationDialog() {
    const notifications = appStore.state.data.notifications
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return `<dialog id="notifications-dialog" aria-labelledby="notifications-title">
      <div class="dialog-head"><div><h2 class="dialog-title" id="notifications-title">${t("notifications")}</h2><span class="muted">${notifications.filter((item) => !item.read).length} ${t("unread").toLowerCase()}</span></div><button class="icon-button close-notifications" aria-label="${t("close")}">${icon("close")}</button></div>
      <div class="notification-list">
        ${notifications
          .map(
            (item) =>
              `<div class="notification-item" style="${item.read ? "opacity:.65" : ""}"><span class="activity-icon">${icon(item.type === "warning" ? "alert" : item.type === "success" ? "check" : "bell")}</span><div class="activity-copy"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.detail)} · ${formatDate(item.createdAt)}</span></div>${!item.read ? '<span class="notification-dot" style="position:static;border:0"></span>' : ""}</div>`,
          )
          .join("")}
      </div>
      <div class="dialog-actions"><button class="button" id="mark-read">${t("markAllRead")}</button></div>
    </dialog>`;
  }

  bindShellEvents() {
    this.querySelector("#mobile-menu")?.addEventListener("click", () => {
      this.mobileOpen = !this.mobileOpen;
      this.updateMobileMenu();
    });
    this.querySelector(".mobile-overlay")?.addEventListener("click", () => {
      this.mobileOpen = false;
      this.updateMobileMenu();
    });
    this.querySelector("#quick-create")?.addEventListener("click", () => {
      location.hash = "/finance?action=new-invoice";
    });
    this.querySelector("#language-toggle")?.addEventListener("click", () =>
      setLocale(getLocale() === "ar" ? "fr" : "ar"),
    );
    this.querySelector("#logout-button")?.addEventListener("click", async () => {
      if (window.confirm(getLocale() === "ar" ? "تسجيل الخروج؟" : "Se déconnecter ?")) {
        await appStore.logout();
      }
    });
    this.querySelector("#theme-toggle")?.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("mf-theme", next);
      toast(next === "dark" ? t("dark") : t("light"));
    });
    const dialog = this.querySelector("#notifications-dialog");
    this.querySelector("#notifications-button")?.addEventListener("click", () =>
      dialog.showModal(),
    );
    this.querySelector(".close-notifications")?.addEventListener("click", () => dialog.close());
    this.querySelector("#mark-read")?.addEventListener("click", async () => {
      await Promise.all(
        appStore.state.data.notifications.map((item) =>
          appStore.save("notifications", { ...item, read: true }),
        ),
      );
      dialog.close();
      toast(t("saved"));
    });
    this.querySelector("#global-search")?.addEventListener("input", (event) => {
      const query = event.target.value.toLowerCase().trim();
      const match = this.visibleNavItems().find(([name]) => t(name).toLowerCase().includes(query));
      if (query && match && event.inputType === "insertLineBreak") location.hash = `/${match[0]}`;
    });
    this.querySelector("#global-search")?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const query = event.target.value.toLowerCase().trim();
      const match = this.visibleNavItems().find(([name]) => t(name).toLowerCase().includes(query));
      if (match) location.hash = `/${match[0]}`;
    });
  }

  updateMobileMenu() {
    this.querySelector(".sidebar")?.classList.toggle("open", this.mobileOpen);
    this.querySelector("#mobile-menu")?.setAttribute("aria-expanded", String(this.mobileOpen));
  }

  updateNotificationDot() {
    const button = this.querySelector("#notifications-button");
    if (!button) return;
    const unread = appStore.state.data.notifications.some((item) => !item.read);
    button.querySelector(".notification-dot")?.remove();
    if (unread) button.insertAdjacentHTML("beforeend", '<span class="notification-dot"></span>');
  }

  updateConnectivity(showToast = true) {
    const region = this.querySelector("#connectivity-region");
    if (!region) return;
    if (!navigator.onLine) {
      region.innerHTML = `<div class="offline-banner" role="status">${icon("alert")} ${t("offline")}</div>`;
    } else if (appStore.state.syncError) {
      region.innerHTML = `<div class="offline-banner" role="status">${icon("alert")} ${escapeHTML(appStore.state.syncError)}</div>`;
    } else if (appStore.state.syncing) {
      region.innerHTML = `<div class="offline-banner" role="status">${icon("clock")} Syncing…</div>`;
    } else {
      region.innerHTML = "";
    }
    if (showToast && navigator.onLine) toast(t("online"));
  }
}

customElements.define("morocco-flow-app", MoroccoFlowApp);
