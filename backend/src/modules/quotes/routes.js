import { can } from "../../lib/rbac.js";
import { respondAfterCommit } from "../../lib/crud.js";
import { beginIdempotency, completeIdempotency } from "../../lib/idempotency.js";
import { toPublicJson } from "../../lib/serialize.js";
import { acceptQuote, quoteDetail } from "./service.js";

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
