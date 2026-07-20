import Redis from "ioredis";

export async function cachePlugin(app, options) {
  const redis = new Redis(options.config.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    commandTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
  });
  redis.on("error", (error) => app.log.warn({ err: error }, "Redis connection error"));
  await redis.connect();
  app.decorate("redis", redis);
  app.addHook("onClose", async () => redis.quit());
}
