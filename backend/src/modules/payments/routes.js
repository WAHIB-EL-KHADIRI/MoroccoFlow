import { respondAfterCommit } from "../../lib/crud.js";
import { beginIdempotency, completeIdempotency } from "../../lib/idempotency.js";
import { toPublicJson } from "../../lib/serialize.js";
import {
  listObligations,
  obligationWithPayments,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  recordPayment,
} from "./service.js";

const idParams = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
};

export async function paymentRoutes(app) {
  app.get(
    "/payment-obligations",
    {
      preHandler: app.requirePermission("finance:read"),
      schema: {
        tags: ["Payments"],
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: PAYMENT_STATUSES },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
        },
      },
    },
    async (request) =>
      app.withTenant(request.auth, async (client) => ({
        data: toPublicJson(
          await listObligations(client, {
            status: request.query.status,
            limit: request.query.limit || 50,
          }),
        ),
      })),
  );

  app.get(
    "/payment-obligations/:id",
    {
      preHandler: app.requirePermission("finance:read"),
      schema: { tags: ["Payments"], params: idParams },
    },
    async (request) =>
      app.withTenant(request.auth, async (client) => ({
        data: toPublicJson(await obligationWithPayments(client, request.params.id)),
      })),
  );

  app.post(
    "/payment-obligations/:id/payments",
    {
      preHandler: app.requirePermission("finance:write"),
      schema: {
        tags: ["Payments"],
        params: idParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["amountCents", "paidOn"],
          properties: {
            amountCents: { type: "integer", minimum: 1, maximum: 9007199254740991 },
            paidOn: { type: "string", format: "date" },
            method: { type: "string", enum: PAYMENT_METHODS },
            reference: { anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }] },
          },
        },
      },
    },
    async (request, reply) =>
      respondAfterCommit(app, request, reply, async (client) => {
        const gate = await beginIdempotency(client, request.auth, request);
        if (gate?.cached) return gate.cached;
        const result = await recordPayment(
          client,
          request.auth,
          { ...request.body, obligationId: request.params.id },
          (entry) => app.writeAudit(client, request.auth, { ...entry, request }),
        );
        const payload = { data: toPublicJson(result) };
        await completeIdempotency(client, request.auth, gate, 201, payload);
        return { statusCode: 201, body: payload };
      }),
  );
}
