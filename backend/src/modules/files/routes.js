import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { AppError, notFound } from "../../lib/errors.js";
import { safeTokenEqual } from "../../lib/crypto.js";
import { toPublicJson } from "../../lib/serialize.js";

const allowedMime = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

function detectedMime(buffer) {
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}

function safeFilename(value) {
  return (
    String(value)
      .replace(/[\r\n"\\/]/g, "_")
      .slice(0, 180) || "document"
  );
}

export async function fileRoutes(app) {
  app.post(
    "/files",
    {
      preHandler: app.requirePermission("files:write"),
      config: { rateLimit: { max: 30, timeWindow: "1 hour" } },
      schema: { tags: ["Files"] },
    },
    async (request, reply) => {
      const part = await request.file({ limits: { files: 1, fileSize: 10 * 1024 * 1024 } });
      if (!part) throw new AppError("FILE_REQUIRED", "A file is required", 400);
      const buffer = await part.toBuffer();
      const mime = detectedMime(buffer);
      if (!mime || mime !== part.mimetype || !allowedMime.has(mime)) {
        throw new AppError(
          "INVALID_FILE_TYPE",
          "Only valid PDF, PNG, JPEG and WebP files are allowed",
          415,
        );
      }
      if (!buffer.length || buffer.length > 10 * 1024 * 1024) {
        throw new AppError("INVALID_FILE_SIZE", "File must be between 1 byte and 10 MB", 413);
      }
      const id = randomUUID();
      const key = `${request.auth.tenantId}/${id}`;
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const scanStatus = app.config.fileScanningRequired ? "pending" : "clean";
      await app.storage.send(
        new PutObjectCommand({
          Bucket: app.config.s3.bucket,
          Key: key,
          Body: buffer,
          ContentType: mime,
          Metadata: { sha256, tenant: request.auth.tenantId },
          ...(app.config.s3.serverSideEncryption
            ? { ServerSideEncryption: app.config.s3.serverSideEncryption }
            : {}),
        }),
      );
      return app.withTenant(request.auth, async (client) => {
        const result = await client.query(
          `INSERT INTO files
             (id, tenant_id, storage_key, original_name, content_type, byte_size, sha256,
              scan_status, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, original_name, content_type, byte_size, sha256, scan_status, created_at`,
          [
            id,
            request.auth.tenantId,
            key,
            safeFilename(part.filename),
            mime,
            buffer.length,
            sha256,
            scanStatus,
            request.auth.userId,
          ],
        );
        await app.writeAudit(client, request.auth, {
          action: "file.uploaded",
          entityType: "file",
          entityId: id,
          after: result.rows[0],
          request,
        });
        return reply.code(201).send({ data: toPublicJson(result.rows[0]) });
      });
    },
  );

  app.get(
    "/files/:id",
    {
      preHandler: app.requirePermission("files:read"),
      schema: {
        tags: ["Files"],
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const row = await app.withTenant(request.auth, async (client) => {
        const result = await client.query(
          `SELECT storage_key, original_name, content_type, byte_size, scan_status
           FROM files WHERE id = $1 AND deleted_at IS NULL`,
          [request.params.id],
        );
        if (!result.rowCount) throw notFound("File");
        if (result.rows[0].scan_status !== "clean") {
          throw new AppError(
            "FILE_QUARANTINED",
            "File is unavailable until security scanning completes",
            423,
          );
        }
        return result.rows[0];
      });
      const object = await app.storage.send(
        new GetObjectCommand({ Bucket: app.config.s3.bucket, Key: row.storage_key }),
      );
      reply.header("content-type", row.content_type);
      reply.header("content-length", row.byte_size);
      reply.header(
        "content-disposition",
        `attachment; filename="${safeFilename(row.original_name)}"`,
      );
      reply.header("x-content-type-options", "nosniff");
      return reply.send(object.Body);
    },
  );

  app.post(
    "/internal/files/scan-result",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        hide: true,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["tenantId", "fileId", "status"],
          properties: {
            tenantId: { type: "string", format: "uuid" },
            fileId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["clean", "infected", "failed"] },
          },
        },
      },
    },
    async (request, reply) => {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
      if (!safeTokenEqual(token, app.config.fileScanToken)) throw notFound();
      await app.withTenant(
        { tenantId: request.body.tenantId, userId: request.body.fileId, role: "viewer" },
        (client) =>
          client.query(
            "UPDATE files SET scan_status = $2 WHERE id = $1 AND scan_status = 'pending'",
            [request.body.fileId, request.body.status],
          ),
      );
      return reply.code(204).send();
    },
  );
}
