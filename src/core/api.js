const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim();
export const apiEnabled = Boolean(configuredBase);
const apiBase = configuredBase?.replace(/\/$/, "") || "";
let accessToken = null;
let refreshInFlight = null;

export class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class AuthRequiredError extends ApiError {
  constructor() {
    super("Authentication is required", 401, "UNAUTHORIZED");
    this.name = "AuthRequiredError";
  }
}

async function parseResponse(response) {
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") || "";
  return type.includes("application/json") ? response.json() : response.text();
}

async function request(path, options = {}, retry = true) {
  const { raw = false, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  if (requestOptions.body !== undefined) headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  let response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...requestOptions,
      headers,
      credentials: "include",
      body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
    });
  } catch {
    throw new ApiError("The server is unreachable", 0, "NETWORK_ERROR");
  }
  if (response.status === 401 && retry && !path.startsWith("/auth/")) {
    await apiClient.refresh();
    return request(path, options, false);
  }
  const payload = await parseResponse(response);
  if (!response.ok) {
    const error = payload?.error || {};
    if (response.status === 401) throw new AuthRequiredError();
    throw new ApiError(
      error.message || "API request failed",
      response.status,
      error.code,
      error.details,
    );
  }
  return raw ? payload : (payload?.data ?? payload);
}

async function collection(path) {
  const records = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await request(`${path}?${query}`, { raw: true });
    records.push(...(response?.data || response || []));
    cursor = response?.page?.hasMore ? response.page.nextCursor : null;
  } while (cursor);
  return records;
}

async function optionalCollection(path) {
  try {
    return await collection(path);
  } catch (error) {
    if (error.status === 403) return [];
    throw error;
  }
}

async function optionalRequest(path) {
  try {
    return await request(path);
  } catch (error) {
    if (error.status === 403) return [];
    throw error;
  }
}
function dateOnly(value) {
  return value ? String(value).slice(0, 10) : null;
}

function adapt(store, row) {
  if (store === "deals") return { ...row, amount: Number(row.amountCents || 0) };
  if (store === "tasks") return { ...row, assignee: row.assigneeUserId };
  if (store === "invoices") {
    return { ...row, date: row.issueDate, amount: Number(row.totalCents || 0) };
  }
  if (store === "expenses") {
    return { ...row, date: row.expenseDate, amount: Number(row.amountCents || 0) };
  }
  if (store === "employees") {
    return { ...row, name: row.fullName, role: String(row.role).replaceAll("_", " ") };
  }
  if (store === "notifications") return { ...row, read: Boolean(row.readAt) };
  return row;
}

const endpoint = {
  clients: "/clients",
  deals: "/deals",
  projects: "/projects",
  tasks: "/tasks",
  invoices: "/invoices",
  expenses: "/expenses",
};

function writableBody(store, entity, includeId) {
  const map = {
    clients: ["name", "company", "email", "phone", "city", "ice", "status", "notes"],
    deals: ["clientId", "title", "stage", "probability", "ownerUserId", "expectedCloseDate"],
    projects: [
      "clientId",
      "name",
      "description",
      "status",
      "progress",
      "startDate",
      "dueDate",
      "ownerUserId",
    ],
    tasks: ["projectId", "title", "description", "status", "priority", "dueDate", "position"],
    invoices: ["clientId", "quoteId", "number", "status", "dueDate", "notes"],
    expenses: ["label", "category", "receiptFileId"],
  };
  const body = {};
  if (includeId) body.id = entity.id;
  for (const key of map[store] || []) {
    if (entity[key] !== undefined && entity[key] !== "") body[key] = entity[key];
  }
  if (store === "deals") body.amountCents = Number(entity.amount || 0);
  if (store === "tasks") body.assigneeUserId = entity.assignee || entity.assigneeUserId || null;
  if (store === "invoices") {
    body.issueDate = dateOnly(entity.date || entity.issueDate);
    body.dueDate = dateOnly(entity.dueDate);
    body.subtotalCents = Number(entity.amount || entity.subtotalCents || 0);
    body.taxCents = 0;
    body.paidCents = entity.status === "paid" ? body.subtotalCents : 0;
    body.currency = "MAD";
  }
  if (store === "expenses") {
    body.expenseDate = dateOnly(entity.date || entity.expenseDate);
    body.amountCents = Number(entity.amount || entity.amountCents || 0);
    body.currency = "MAD";
  }
  return body;
}

/** Quotes are a server-side workflow: no offline outbox, no local copy. */
export const quotesApi = {
  async list({ q } = {}) {
    const query = new URLSearchParams({ limit: "100" });
    if (q) query.set("q", q);
    const response = await request(`/quotes?${query}`, { raw: true });
    return response?.data || [];
  },
  get: (id) => request(`/quotes/${id}`),
  create: (body, key) =>
    request("/quotes", { method: "POST", headers: { "idempotency-key": key }, body }),
  update: (id, body) => request(`/quotes/${id}`, { method: "PATCH", body }),
  // The key is minted once per dialog: a double click or a network retry replays the
  // first answer instead of acting twice.
  accept: (id, body, key) =>
    request(`/quotes/${id}/accept`, { method: "POST", headers: { "idempotency-key": key }, body }),
};

export const apiClient = {
  async login(credentials) {
    const body = { ...credentials };
    if (!body.mfaCode) delete body.mfaCode;
    const data = await request("/auth/login", { method: "POST", body }, false);
    accessToken = data.accessToken;
    return data;
  },

  // Refresh tokens rotate and a reused one is rejected, so simultaneous 401s (pullWorkspace
  // fires eight requests at once) must share one refresh. A second /auth/refresh with the
  // already-rotated cookie would fail and sign the user out.
  refresh() {
    refreshInFlight ??= request("/auth/refresh", { method: "POST" }, false)
      .then((data) => {
        accessToken = data.accessToken;
        return data;
      })
      .finally(() => {
        refreshInFlight = null;
      });
    return refreshInFlight;
  },

  async logout() {
    try {
      await request("/auth/logout", { method: "POST" }, false);
    } finally {
      accessToken = null;
    }
  },

  async pullWorkspace() {
    const me = await request("/auth/me");
    const [clients, deals, projects, tasks, invoices, expenses, employees, notifications] =
      await Promise.all([
        optionalCollection("/clients"),
        optionalCollection("/deals"),
        optionalCollection("/projects"),
        optionalCollection("/tasks"),
        optionalCollection("/invoices"),
        optionalCollection("/expenses"),
        optionalRequest("/team"),
        request("/notifications?limit=100"),
      ]);
    return {
      data: {
        clients: clients.map((row) => adapt("clients", row)),
        deals: deals.map((row) => adapt("deals", row)),
        projects: projects.map((row) => adapt("projects", row)),
        tasks: tasks.map((row) => adapt("tasks", row)),
        invoices: invoices.map((row) => adapt("invoices", row)),
        expenses: expenses.map((row) => adapt("expenses", row)),
        employees: employees.map((row) => adapt("employees", row)),
        notifications: notifications.map((row) => adapt("notifications", row)),
        settings: [
          { id: "company", name: me.tenantName, workspace: me.tenantSlug, currency: "MAD" },
        ],
      },
      user: me,
    };
  },

  async pushMutation(mutation) {
    const { storeName, action, entity } = mutation;
    if (storeName === "notifications" && action === "save" && entity.read) {
      return request(`/notifications/${entity.id}/read`, { method: "PATCH" });
    }
    const path = endpoint[storeName];
    if (!path) return null;
    if (action === "delete") {
      return request(`${path}/${entity.id}?version=${entity.version}`, {
        method: "DELETE",
        headers: { "idempotency-key": mutation.mutationId },
      });
    }
    const isUpdate = Number.isInteger(entity.version);
    const body = writableBody(storeName, entity, !isUpdate);
    if (isUpdate) body.version = entity.version;
    return request(isUpdate ? `${path}/${entity.id}` : path, {
      method: isUpdate ? "PATCH" : "POST",
      headers: { "idempotency-key": mutation.mutationId },
      body,
    });
  },
};
