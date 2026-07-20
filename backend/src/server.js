import { buildApp } from "./app.js";

const app = await buildApp();

async function shutdown(signal) {
  app.log.info({ signal }, "Graceful shutdown started");
  const forced = setTimeout(() => process.exit(1), 25_000);
  forced.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, "Graceful shutdown failed");
    process.exit(1);
  }
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

try {
  await app.listen({ host: app.config.host, port: app.config.port });
} catch (error) {
  app.log.fatal({ err: error }, "MoroccoFlow API failed to start");
  process.exit(1);
}
