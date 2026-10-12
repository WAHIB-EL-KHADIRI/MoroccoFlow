/**
 * The shared UI building blocks: custom elements, toasts and the page helpers every
 * feature screen uses. Chart.js is replaced by a recording stub, so the chart wiring is
 * checked without a canvas; the real library is only loaded on first interaction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chartState = vi.hoisted(() => ({ configs: [], destroyed: 0, registered: 0 }));

vi.mock("chart.js", () => ({
  registerables: [],
  Chart: class {
    static register() {
      chartState.registered += 1;
    }

    constructor(canvas, config) {
      this.canvas = canvas;
      chartState.configs.push(config);
    }

    destroy() {
      chartState.destroyed += 1;
    }
  },
}));

const { toast } = await import("../../src/design-system/components.js");
const { t } = await import("../../src/core/i18n.js");
const { initials } = await import("../../src/shared/formatters.js");
const { csvCell } = await import("../../src/core/security.js");
const { clientName, downloadCsv, emptyState, employeeName, pageHeader } = await import(
  "../../src/features/shared.js"
);

const mount = (html) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild;
};

beforeEach(() => {
  chartState.configs.length = 0;
  chartState.destroyed = 0;
  chartState.registered = 0;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("<mf-stat-card>", () => {
  it("renders label, value and meta", () => {
    const card = mount(
      `<mf-stat-card data-label="Revenue" data-value="12 000 dh" data-meta="+4%"></mf-stat-card>`,
    );

    expect(card.querySelector(".stat-head span").textContent).toBe("Revenue");
    expect(card.querySelector(".stat-value").textContent).toBe("12 000 dh");
    expect(card.querySelector(".stat-meta").textContent.trim()).toBe("+4%");
    expect(card.querySelector(".stat-meta").classList.contains("positive")).toBe(true);
  });

  it("marks a negative trend and picks the tone's glow", () => {
    const card = mount(
      `<mf-stat-card data-label="x" data-value="1" data-negative="true" data-tone="saffron"></mf-stat-card>`,
    );

    expect(card.querySelector(".stat-meta").classList.contains("negative")).toBe(true);
    expect(card.style.getPropertyValue("--card-glow")).toBe("var(--saffron-soft)");
  });

  it("defaults to the emerald tone", () => {
    const card = mount(`<mf-stat-card data-label="x" data-value="1"></mf-stat-card>`);

    expect(card.style.getPropertyValue("--card-glow")).toBe("var(--emerald-100)");
  });

  it("never turns data attributes into markup", () => {
    const card = mount(
      `<mf-stat-card data-label="&lt;img src=x onerror=alert(1)&gt;" data-value="&lt;b&gt;9&lt;/b&gt;"></mf-stat-card>`,
    );

    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector(".stat-value b")).toBeNull();
    expect(card.querySelector(".stat-value").textContent).toBe("<b>9</b>");
  });
});

describe("<mf-status-badge>", () => {
  it("shows the translated status and mirrors it in data-status", () => {
    const badge = mount(`<mf-status-badge status="paid"></mf-status-badge>`);

    expect(badge.textContent).toBe(t("paid"));
    expect(badge.dataset.status).toBe("paid");
  });

  it("falls back to draft and re-renders when the status changes", () => {
    const badge = mount(`<mf-status-badge></mf-status-badge>`);
    expect(badge.dataset.status).toBe("draft");

    badge.setAttribute("status", "overdue");

    expect(badge.dataset.status).toBe("overdue");
    expect(badge.textContent).toBe(t("overdue"));
  });
});

describe("<mf-avatar>", () => {
  it("shows initials and the full name as a tooltip", () => {
    const avatar = mount(`<mf-avatar name="Amina El Fassi"></mf-avatar>`);

    expect(avatar.textContent).toBe(initials("Amina El Fassi"));
    expect(avatar.title).toBe("Amina El Fassi");
  });

  it("copes with a missing name", () => {
    const avatar = mount(`<mf-avatar></mf-avatar>`);

    expect(avatar.title).toBe("");
  });
});

describe("<mf-chart>", () => {
  const chart = (attrs = "") =>
    mount(`<mf-chart data-values="[0,50,100]" data-labels='["a","b","c"]' ${attrs}></mf-chart>`);
  const upgraded = async (element) => {
    element.dispatchEvent(new Event("pointerenter"));
    await vi.waitFor(() => expect(chartState.configs.length).toBeGreaterThan(0));
    return chartState.configs.at(-1);
  };

  it("draws an accessible SVG fallback first", () => {
    const element = chart(`data-label="Revenue chart"`);
    const svg = element.querySelector("svg");

    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Revenue chart");
    const points = svg.querySelector("polyline").getAttribute("points").split(" ");
    expect(points).toHaveLength(3);
    expect(points.join(" ")).not.toMatch(/NaN|Infinity/);
    expect(svg.querySelectorAll("line")).toHaveLength(4);
    expect(chartState.configs).toHaveLength(0); // the real library is not loaded yet
  });

  it("survives empty and all-zero data without NaN coordinates", () => {
    for (const values of ["[]", "[0,0,0]", "[5]"]) {
      const element = mount(`<mf-chart data-values="${values}"></mf-chart>`);
      expect(element.querySelector("polyline").getAttribute("points")).not.toMatch(/NaN|Infinity/);
    }
  });

  it("upgrades to Chart.js on first interaction, once", async () => {
    const element = chart();

    const config = await upgraded(element);
    element.dispatchEvent(new Event("pointerenter"));
    element.dispatchEvent(new Event("focusin"));

    expect(element.querySelector("canvas").getAttribute("role")).toBe("img");
    expect(chartState.configs).toHaveLength(1);
    expect(chartState.registered).toBe(1);
    expect(config.type).toBe("line");
    expect(config.data.labels).toEqual(["a", "b", "c"]);
    expect(config.data.datasets[0].data).toEqual([0, 50, 100]);
    expect(config.data.datasets[0].fill).toBe(true);
  });

  it("formats tooltips in dirhams and axis ticks in thousands", async () => {
    const config = await upgraded(chart());
    const { label } = config.options.plugins.tooltip.callbacks;
    const { callback } = config.options.scales.y.ticks;

    expect(label({ raw: 0 })).toBe("0 dh");
    // Separator and currency symbol depend on the locale data (fr-MA gives "1.500,00MAD").
    expect(label({ raw: 1500 })).toMatch(/^1\D?500/);
    expect(label({ raw: 1500 })).not.toMatch(/NaN/);
    expect(callback(12000)).toBe("12k");
  });

  it("uses a legend and no axes for a doughnut", async () => {
    const config = await upgraded(chart(`data-type="doughnut"`));

    expect(config.type).toBe("doughnut");
    expect(config.options.scales).toEqual({});
    expect(config.options.plugins.legend.display).toBe(true);
    expect(config.data.datasets[0].fill).toBe(false);
  });

  it("does nothing if it was removed before the interaction", async () => {
    const element = chart();
    element.remove();

    element.dispatchEvent(new Event("pointerenter"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(chartState.configs).toHaveLength(0);
  });

  it("destroys the chart when removed", async () => {
    const element = chart();
    await upgraded(element);

    element.remove();

    expect(chartState.destroyed).toBe(1);
  });
});

describe("toast()", () => {
  it("does nothing without a toast region", () => {
    expect(() => toast("hello")).not.toThrow();
  });

  it("shows a status message and removes it after 3.2 seconds", () => {
    vi.useFakeTimers();
    mount(`<div class="toast-region"></div>`);

    toast("Saved");
    const element = document.querySelector(".toast");

    expect(element.getAttribute("role")).toBe("status");
    expect(element.textContent).toContain("Saved");
    vi.advanceTimersByTime(3199);
    expect(document.querySelector(".toast")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("announces errors as alerts and escapes the message", () => {
    mount(`<div class="toast-region"></div>`);

    toast("<img src=x onerror=alert(1)>", "error");

    const element = document.querySelector(".toast");
    expect(element.getAttribute("role")).toBe("alert");
    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("page helpers", () => {
  it("pageHeader escapes text and omits empty parts", () => {
    const html = pageHeader({ title: "<script>x</script>" });

    expect(html).not.toContain("<script>");
    expect(html).toContain("MoroccoFlow");
    expect(html).not.toContain("page-subtitle");
    expect(html).not.toContain("button-row");
  });

  it("pageHeader renders subtitle and actions when given", () => {
    const html = pageHeader({ title: "Clients", subtitle: "All of them", actions: "<button>Add</button>" });

    expect(html).toContain("All of them");
    expect(html).toContain("<button>Add</button>");
  });

  it("emptyState shows the translated message and an optional action", () => {
    const html = emptyState("<a>Create</a>");

    expect(html).toContain(t("empty"));
    expect(html).toContain("<a>Create</a>");
  });

  it("looks names up and falls back to a dash", () => {
    expect(clientName([{ id: "1", company: "Atlas SARL" }], "1")).toBe("Atlas SARL");
    expect(clientName([], "1")).toBe("—");
    expect(employeeName([{ id: "7", name: "Youssef" }], "7")).toBe("Youssef");
    expect(employeeName([{ id: "7", name: "" }], "7")).toBe("—");
  });
});

describe("downloadCsv()", () => {
  // jsdom's Blob has no reliable text()/arrayBuffer(); FileReader is always available.
  const readBytes = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });

  const capture = () => {
    const created = [];
    URL.createObjectURL = vi.fn((blob) => {
      created.push(blob);
      return "blob:test";
    });
    URL.revokeObjectURL = vi.fn();
    const clicked = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click() {
      clicked.push({ download: this.download, href: this.href });
    });
    return { created, clicked };
  };

  it("downloads an Excel-friendly file: BOM, CRLF, every cell quoted", async () => {
    const { created, clicked } = capture();

    downloadCsv("clients.csv", ["name", "city"], [["Atlas", "Fès"], ['He said "hi"', "Rabat"]]);

    expect(clicked).toEqual([{ download: "clients.csv", href: "blob:test" }]);
    const bytes = await readBytes(created[0]);
    expect(created[0].type).toContain("text/csv");
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM, so Excel reads Fès
    expect(new TextDecoder().decode(bytes.slice(3))).toBe(
      '"name","city"\r\n"Atlas","Fès"\r\n"He said ""hi""","Rabat"',
    );
  });

  it("neutralises spreadsheet formulas in cells", async () => {
    const { created } = capture();

    downloadCsv("x.csv", ["v"], [["=HYPERLINK(1)"], ["+1"], ["-1"], ["@SUM(A1)"]]);

    const text = new TextDecoder().decode((await readBytes(created[0])).slice(3));
    expect(text).toContain(`"'=HYPERLINK(1)"`);
    expect(text).not.toMatch(/\r\n"[=+\-@]/);
  });

  it("releases the object URL after a second", () => {
    vi.useFakeTimers();
    capture();

    downloadCsv("x.csv", ["a"], []);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });
});

describe("csvCell()", () => {
  it("guards every character a spreadsheet treats as a formula start", () => {
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(csvCell(`${lead}cmd`), JSON.stringify(lead)).toBe(`"'${lead}cmd"`);
    }
  });

  it("quotes ordinary values and doubles embedded quotes", () => {
    expect(csvCell("plain")).toBe('"plain"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell(12)).toBe('"12"');
    expect(csvCell()).toBe('""');
  });
});
