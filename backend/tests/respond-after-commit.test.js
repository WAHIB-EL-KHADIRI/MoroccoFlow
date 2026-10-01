import { describe, expect, it } from "vitest";
import { respondAfterCommit } from "../src/lib/crud.js";

/** A transaction double that records when COMMIT happens relative to the reply. */
function harness({ commitFails = false } = {}) {
  const events = [];
  const app = {
    async withTenant(auth, operation) {
      events.push(`begin:${auth.tenantId}`);
      const result = await operation({});
      if (commitFails) throw new Error("commit failed");
      events.push("commit");
      return result;
    },
  };
  const reply = {
    code(status) {
      events.push(`status:${status}`);
      return this;
    },
    send(body) {
      events.push(`send:${JSON.stringify(body ?? null)}`);
      return this;
    },
  };
  return { app, reply, events, request: { auth: { tenantId: "t1" } } };
}

describe("respondAfterCommit", () => {
  it("sends the response only after the transaction has committed", async () => {
    const { app, reply, events, request } = harness();
    await respondAfterCommit(app, request, reply, async () => ({
      statusCode: 201,
      body: { data: { id: "x" } },
    }));
    expect(events).toEqual(["begin:t1", "commit", "status:201", 'send:{"data":{"id":"x"}}']);
  });

  it("sends nothing when the commit fails, so the error handler answers instead", async () => {
    const { app, reply, events, request } = harness({ commitFails: true });
    await expect(
      respondAfterCommit(app, request, reply, async () => ({ statusCode: 201, body: {} })),
    ).rejects.toThrow("commit failed");
    expect(events).toEqual(["begin:t1"]);
  });

  it("uses an explicit auth context when the caller has no session yet", async () => {
    const { app, reply, events, request } = harness();
    await respondAfterCommit(app, request, reply, async () => ({ statusCode: 204 }), {
      tenantId: "bootstrap",
    });
    expect(events).toEqual(["begin:bootstrap", "commit", "status:204", "send:null"]);
  });
});
