import { t } from "../core/i18n.js";
import { initials } from "../shared/formatters.js";
import { escapeHTML } from "../core/security.js";
import { icon } from "./icons.js";

class MFStatCard extends HTMLElement {
  connectedCallback() {
    const tone = this.dataset.tone || "emerald";
    const glows = {
      emerald: "var(--emerald-100)",
      saffron: "var(--saffron-soft)",
      clay: "var(--clay-soft)",
      blue: "var(--blue-soft)",
    };
    this.style.setProperty("--card-glow", glows[tone]);
    this.innerHTML = `
      <div class="stat-head">
        <span>${escapeHTML(this.dataset.label)}</span>
        <span class="stat-icon">${icon(this.dataset.icon || "trend")}</span>
      </div>
      <div class="stat-value">${escapeHTML(this.dataset.value)}</div>
      <div class="stat-meta ${this.dataset.negative === "true" ? "negative" : "positive"}">
        ${escapeHTML(this.dataset.meta || "")}
      </div>`;
  }
}

class MFStatusBadge extends HTMLElement {
  static observedAttributes = ["status"];

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  render() {
    const status = this.getAttribute("status") || "draft";
    this.dataset.status = status;
    this.textContent = t(status);
  }
}

class MFAvatar extends HTMLElement {
  connectedCallback() {
    this.textContent = initials(this.getAttribute("name") || "");
    this.title = this.getAttribute("name") || "";
  }
}

class MFChart extends HTMLElement {
  connectedCallback() {
    const data = JSON.parse(this.dataset.values || "[]");
    const labels = JSON.parse(this.dataset.labels || "[]");
    this.replaceChildren(this.drawFallback(data));
    const upgrade = () => this.upgrade(data, labels);
    this.addEventListener("pointerenter", upgrade, { once: true });
    this.addEventListener("focusin", upgrade, { once: true });
    this.timer = setTimeout(upgrade, 8000);
  }

  drawFallback(data) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 600 280");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", this.dataset.label || "Financial chart");
    svg.style.width = "100%";
    svg.style.height = "280px";
    const style = getComputedStyle(document.documentElement);
    const color = style.getPropertyValue("--emerald-500").trim();
    const grid = style.getPropertyValue("--border").trim();
    for (let row = 1; row < 5; row += 1) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", "0");
      line.setAttribute("x2", "600");
      line.setAttribute("y1", String(row * 56));
      line.setAttribute("y2", String(row * 56));
      line.setAttribute("stroke", grid);
      svg.append(line);
    }
    const max = Math.max(...data, 1);
    const points = data
      .map((value, index) => {
        const x = 14 + (index / Math.max(data.length - 1, 1)) * 572;
        const y = 260 - (value / max) * 230;
        return `${x},${y}`;
      })
      .join(" ");
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", points);
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", color);
    polyline.setAttribute("stroke-width", "4");
    polyline.setAttribute("stroke-linecap", "round");
    polyline.setAttribute("stroke-linejoin", "round");
    svg.append(polyline);
    return svg;
  }

  async upgrade(data, labels) {
    if (this.chart || this.upgrading || !this.isConnected) return;
    this.upgrading = true;
    clearTimeout(this.timer);
    const { Chart, registerables } = await import("chart.js");
    if (!this.isConnected) return;
    Chart.register(...registerables);
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", this.dataset.label || "Financial chart");
    this.replaceChildren(canvas);
    const type = this.dataset.type || "line";
    const style = getComputedStyle(document.documentElement);
    const emerald = style.getPropertyValue("--emerald-500").trim();
    const saffron = style.getPropertyValue("--saffron").trim();
    const ink = style.getPropertyValue("--ink-500").trim();
    const border = style.getPropertyValue("--border").trim();
    this.chart = new Chart(canvas, {
      type,
      data: {
        labels,
        datasets: [
          {
            label: this.dataset.series || t("revenue"),
            data,
            borderColor: emerald,
            backgroundColor:
              type === "line" ? `${emerald}20` : [emerald, saffron, "#7661be", "#3d6fc4"],
            fill: type === "line",
            tension: 0.38,
            borderWidth: 2,
            pointRadius: type === "line" ? 2 : 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: type !== "line", labels: { color: ink, usePointStyle: true } },
          tooltip: {
            callbacks: {
              label: (context) =>
                Number(context.raw) === 0
                  ? "0 dh"
                  : new Intl.NumberFormat("fr-MA", {
                      style: "currency",
                      currency: "MAD",
                    }).format(context.raw),
            },
          },
        },
        scales:
          type === "doughnut"
            ? {}
            : {
                x: { grid: { display: false }, ticks: { color: ink } },
                y: {
                  beginAtZero: true,
                  grid: { color: border },
                  ticks: { color: ink, callback: (value) => `${value / 1000}k` },
                },
              },
      },
    });
  }

  disconnectedCallback() {
    clearTimeout(this.timer);
    this.chart?.destroy();
  }
}
customElements.define("mf-stat-card", MFStatCard);
customElements.define("mf-status-badge", MFStatusBadge);
customElements.define("mf-avatar", MFAvatar);
customElements.define("mf-chart", MFChart);

export function toast(message, type = "success") {
  const region = document.querySelector(".toast-region");
  if (!region) return;
  const element = document.createElement("div");
  element.className = "toast";
  element.setAttribute("role", type === "error" ? "alert" : "status");
  element.innerHTML = `${icon(type === "error" ? "alert" : "check")}<span>${escapeHTML(message)}</span>`;
  region.append(element);
  setTimeout(() => element.remove(), 3200);
}
