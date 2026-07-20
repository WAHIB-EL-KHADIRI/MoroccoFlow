function camelKey(key) {
  return key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function toPublicJson(value) {
  if (Array.isArray(value)) return value.map(toPublicJson);
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [camelKey(key), toPublicJson(child)]),
  );
}

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ updatedAt: row.updated_at, id: row.id }), "utf8").toString(
    "base64url",
  );
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value.updatedAt || !/^[0-9a-f-]{36}$/i.test(value.id)) throw new Error("Invalid cursor");
    return value;
  } catch {
    return null;
  }
}
