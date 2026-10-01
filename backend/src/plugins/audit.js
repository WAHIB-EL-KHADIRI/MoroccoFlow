export async function insertAudit(
  client,
  auth,
  { action, entityType, entityId, before, after, request },
) {
  await client.query(
    `INSERT INTO audit_logs
      (tenant_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, ip_hash, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
       encode(digest(COALESCE($8, ''), 'sha256'), 'hex'), $9)`,
    [
      auth.tenantId,
      auth.userId,
      action,
      entityType,
      entityId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      request?.ip,
      request?.headers["user-agent"]?.slice(0, 300),
    ],
  );
}

export async function auditPlugin(app) {
  app.decorate("writeAudit", insertAudit);
}
