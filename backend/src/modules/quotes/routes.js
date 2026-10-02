import { can } from "../../lib/rbac.js";
import { respondAfterCommit } from "../../lib/crud.js";
import { beginIdempotency, completeIdempotency } from "../../lib/idempotency.js";
import { toPublicJson } from "../../lib/serialize.js";
import { acceptQuote, quoteDetail } from "./service.js";
import { replaceQuoteLines } from "./lines.js";
import { MOROCCAN_VAT_RATES_BP } from "../../lib/vat.js";

const idParams = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
};

export async function quoteRoutes(app) {
  app.get(
    "/quotes/:id",
    {
      preHandler: app.requirePermission("quotes:read"),
      schema: { tags: ["quote"], params: idParams },
    },
    async (request) =>
      app.withTenant(request.auth, async (client) => ({
        data: toPublicJson(
          await quoteDetail(client, request.params.id, {
            // Sales owns quotes but not the money: balances stay with finance roles.
            includeFinance: can(request.auth.role, "finance:read"),
          }),
        ),
      })),
  );

  app.put(
    "/quotes/:id/lines",
    {
      preHandler: app.requirePermission("quotes:write"),
      schema: {
        tags: ["quote"],
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["lines"],
          properties: {
            lines: {
              type: "array",
              maxItems: 200,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["description", "quantity", "unitPriceCents"],
                properties: {
                  description: { type: "string", minLength: 1, maxLength: 500 },
                  // Exact decimal text (numeric(14, 3)); JSON numbers are coerced to text.
                  quantity: { type: "string", pattern: "^[0-9]{1,11}(\\.[0-9]{1,3})?$" },
                  unitPriceCents: { type: "integer", minimum: 0, maximum: 9007199254740991 },
                  taxRateBasisPoints: { type: "integer", enum: [...MOROCCAN_VAT_RATES_BP] },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) =>
      respondAfterCommit(app, request, reply, async (client) => {
        const gate = await beginIdempotency(client, request.auth, request);
        if (gate?.cached) return gate.cached;
        const result = await replaceQuoteLines(
          client,
          request.auth,
          request.params.id,
          request.body.lines,
          (entry) => app.writeAudit(client, request.auth, { ...entry, request }),
        );
        const payload = { data: toPublicJson(result) };
        await completeIdempotency(client, request.auth, gate, 200, payload);
        return { statusCode: 200, body: payload };
      }),
  );

  app.post(
    "/quotes/:id/accept",
    {
      preHandler: app.requirePermission("quotes:write"),
      schema: {
        tags: ["quote"],
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["dueDate"],
          properties: {
            dueDate: { type: "string", format: "date" },
            projectName: { type: "string", minLength: 2, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) =>
      respondAfterCommit(app, request, reply, async (client) => {
        const gate = await beginIdempotency(client, request.auth, request);
        if (gate?.cached) return gate.cached;
        const result = await acceptQuote(
          client,
          request.auth,
          { ...request.body, quoteId: request.params.id },
          (entry) => app.writeAudit(client, request.auth, { ...entry, request }),
        );
        const statusCode = result.replayed ? 200 : 201;
        const payload = { data: toPublicJson(result) };
        await completeIdempotency(client, request.auth, gate, statusCode, payload);
        return { statusCode, body: payload };
      }),
  );
}
