export const uuid = { type: "string", format: "uuid" };

export const errorResponse = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "requestId"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
        details: {},
      },
    },
  },
};

export const paginationQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string", maxLength: 200 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
    q: { type: "string", maxLength: 120 },
  },
};
