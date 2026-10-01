import { registerCrudRoutes } from "../../lib/crud.js";
import {
  assertQuoteDeletable,
  assertQuoteUpdate,
  CREATABLE_QUOTE_STATUSES,
  WRITABLE_QUOTE_STATUSES,
} from "../quotes/lifecycle.js";

const nullableString = (maxLength) => ({
  anyOf: [{ type: "string", maxLength }, { type: "null" }],
});
const nullableUuid = { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] };
const nullableDate = { anyOf: [{ type: "string", format: "date" }, { type: "null" }] };
const money = { type: "integer", minimum: 0, maximum: 9007199254740991 };

export async function resourceRoutes(app) {
  registerCrudRoutes(app, {
    path: "/clients",
    table: "clients",
    entity: "client",
    permission: "crm",
    required: ["name", "company"],
    searchColumns: ["name", "company", "email", "phone", "city"],
    fieldMap: {
      name: "name",
      company: "company",
      email: "email",
      phone: "phone",
      city: "city",
      ice: "ice",
      status: "status",
      notes: "notes",
    },
    properties: {
      name: { type: "string", minLength: 2, maxLength: 160 },
      company: { type: "string", minLength: 2, maxLength: 200 },
      email: { anyOf: [{ type: "string", format: "email", maxLength: 254 }, { type: "null" }] },
      phone: nullableString(30),
      city: nullableString(100),
      ice: { anyOf: [{ type: "string", pattern: "^[0-9]{15}$" }, { type: "null" }] },
      status: { type: "string", enum: ["active", "prospect", "archived"] },
      notes: nullableString(5000),
    },
  });

  registerCrudRoutes(app, {
    path: "/deals",
    table: "deals",
    entity: "deal",
    permission: "crm",
    required: ["clientId", "title", "stage"],
    searchColumns: ["title", "stage"],
    fieldMap: {
      clientId: "client_id",
      title: "title",
      stage: "stage",
      amountCents: "amount_cents",
      probability: "probability",
      ownerUserId: "owner_user_id",
      expectedCloseDate: "expected_close_date",
    },
    properties: {
      clientId: { type: "string", format: "uuid" },
      title: { type: "string", minLength: 2, maxLength: 200 },
      stage: { type: "string", enum: ["contact", "qualified", "proposal", "won", "lost"] },
      amountCents: money,
      probability: { type: "integer", minimum: 0, maximum: 100 },
      ownerUserId: nullableUuid,
      expectedCloseDate: nullableDate,
    },
  });

  registerCrudRoutes(app, {
    path: "/projects",
    table: "projects",
    entity: "project",
    permission: "projects",
    required: ["name"],
    searchColumns: ["name", "description", "status"],
    fieldMap: {
      clientId: "client_id",
      name: "name",
      description: "description",
      status: "status",
      progress: "progress",
      startDate: "start_date",
      dueDate: "due_date",
      ownerUserId: "owner_user_id",
    },
    properties: {
      clientId: nullableUuid,
      name: { type: "string", minLength: 2, maxLength: 200 },
      description: nullableString(10000),
      status: { type: "string", enum: ["planned", "active", "paused", "done", "cancelled"] },
      progress: { type: "integer", minimum: 0, maximum: 100 },
      startDate: nullableDate,
      dueDate: nullableDate,
      ownerUserId: nullableUuid,
    },
  });

  registerCrudRoutes(app, {
    path: "/tasks",
    table: "tasks",
    entity: "task",
    permission: "projects",
    required: ["projectId", "title"],
    searchColumns: ["title", "description", "status", "priority"],
    fieldMap: {
      projectId: "project_id",
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      assigneeUserId: "assignee_user_id",
      dueDate: "due_date",
      position: "position",
    },
    properties: {
      projectId: { type: "string", format: "uuid" },
      title: { type: "string", minLength: 2, maxLength: 240 },
      description: nullableString(10000),
      status: { type: "string", enum: ["todo", "doing", "review", "done"] },
      priority: { type: "string", enum: ["low", "medium", "high"] },
      assigneeUserId: nullableUuid,
      dueDate: nullableDate,
      position: { type: "number", minimum: 0, maximum: 1000000000 },
    },
  });

  const documentProperties = {
    clientId: { type: "string", format: "uuid" },
    number: { type: "string", minLength: 1, maxLength: 60 },
    issueDate: { type: "string", format: "date" },
    status: { type: "string", enum: ["draft", "sent", "pending", "paid", "overdue", "cancelled"] },
    subtotalCents: money,
    taxCents: money,
    currency: { type: "string", const: "MAD" },
    notes: nullableString(5000),
  };

  registerCrudRoutes(app, {
    path: "/quotes",
    table: "quotes",
    entity: "quote",
    permission: "quotes",
    required: ["clientId", "number", "issueDate"],
    searchColumns: ["number", "status"],
    fieldMap: {
      clientId: "client_id",
      number: "number",
      issueDate: "issue_date",
      validUntil: "valid_until",
      status: "status",
      subtotalCents: "subtotal_cents",
      taxCents: "tax_cents",
      currency: "currency",
      notes: "notes",
    },
    properties: {
      ...documentProperties,
      status: { type: "string", enum: WRITABLE_QUOTE_STATUSES },
      validUntil: nullableDate,
    },
    createProperties: {
      ...documentProperties,
      status: { type: "string", enum: CREATABLE_QUOTE_STATUSES },
      validUntil: nullableDate,
    },
    guardUpdate: assertQuoteUpdate,
    guardDelete: assertQuoteDeletable,
  });

  registerCrudRoutes(app, {
    path: "/invoices",
    table: "invoices",
    entity: "invoice",
    permission: "finance",
    required: ["clientId", "number", "issueDate", "dueDate"],
    searchColumns: ["number", "status"],
    fieldMap: {
      clientId: "client_id",
      quoteId: "quote_id",
      number: "number",
      issueDate: "issue_date",
      dueDate: "due_date",
      status: "status",
      subtotalCents: "subtotal_cents",
      taxCents: "tax_cents",
      paidCents: "paid_cents",
      currency: "currency",
      notes: "notes",
    },
    properties: {
      ...documentProperties,
      quoteId: nullableUuid,
      dueDate: { type: "string", format: "date" },
      paidCents: money,
    },
  });

  registerCrudRoutes(app, {
    path: "/expenses",
    table: "expenses",
    entity: "expense",
    permission: "finance",
    required: ["label", "category", "expenseDate"],
    searchColumns: ["label", "category"],
    fieldMap: {
      label: "label",
      category: "category",
      expenseDate: "expense_date",
      amountCents: "amount_cents",
      currency: "currency",
      receiptFileId: "receipt_file_id",
    },
    properties: {
      label: { type: "string", minLength: 2, maxLength: 240 },
      category: { type: "string", minLength: 2, maxLength: 80 },
      expenseDate: { type: "string", format: "date" },
      amountCents: money,
      currency: { type: "string", const: "MAD" },
      receiptFileId: nullableUuid,
    },
  });
}
