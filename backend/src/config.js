const requiredInProduction = [
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SECRET",
  "COOKIE_SECRET",
  "BOOTSTRAP_TOKEN",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET",
  "FILE_SCAN_TOKEN",
  "MFA_ENCRYPTION_KEY",
];

function requireSecret(name, value, minimumLength) {
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} must contain at least ${minimumLength} characters`);
  }
  return value;
}

function requireHexKey(name, value) {
  if (!/^[0-9a-f]{64}$/i.test(value || "")) {
    throw new Error(`${name} must contain exactly 64 hexadecimal characters`);
  }
  return value;
}
export function loadConfig(environment = process.env) {
  const nodeEnv = environment.NODE_ENV || "development";
  if (nodeEnv === "production") {
    const missing = requiredInProduction.filter((key) => !environment[key]);
    if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
  }

  const developmentSecret = "development-only-change-me-development-only-change-me-123456789";
  const jwtSecret = environment.JWT_SECRET || developmentSecret;
  const cookieSecret = environment.COOKIE_SECRET || developmentSecret.slice(0, 40);

  return Object.freeze({
    nodeEnv,
    isProduction: nodeEnv === "production",
    host: environment.HOST || "0.0.0.0",
    port: Number(environment.PORT || 3000),
    logLevel: environment.LOG_LEVEL || (nodeEnv === "production" ? "info" : "debug"),
    databaseUrl:
      environment.DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/moroccoflow",
    databaseRole: environment.DATABASE_ROLE || "moroccoflow_app",
    redisUrl: environment.REDIS_URL || "redis://127.0.0.1:6379",
    jwtSecret: requireSecret("JWT_SECRET", jwtSecret, 48),
    cookieSecret: requireSecret("COOKIE_SECRET", cookieSecret, 32),
    accessTokenTtl: environment.ACCESS_TOKEN_TTL || "15m",
    refreshTokenDays: Number(environment.REFRESH_TOKEN_DAYS || 30),
    bootstrapToken: environment.BOOTSTRAP_TOKEN || "local-bootstrap-token-change-me",
    corsOrigins: (environment.CORS_ORIGINS || "http://127.0.0.1:5173,http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    trustedProxies: (environment.TRUSTED_PROXIES || "127.0.0.1,::1")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    docsEnabled: environment.DOCS_ENABLED === "true" || nodeEnv !== "production",
    metricsToken: environment.METRICS_TOKEN || "local-metrics-token",
    fileScanToken: environment.FILE_SCAN_TOKEN || "local-file-scan-token",
    mfaEncryptionKey: requireHexKey(
      "MFA_ENCRYPTION_KEY",
      environment.MFA_ENCRYPTION_KEY || "0".repeat(64),
    ),
    fileScanningRequired:
      environment.FILE_SCANNING_REQUIRED !== "false" && nodeEnv === "production",
    s3: Object.freeze({
      endpoint: environment.S3_ENDPOINT || "http://127.0.0.1:9000",
      region: environment.S3_REGION || "eu-west-3",
      accessKeyId: environment.S3_ACCESS_KEY_ID || "moroccoflow",
      secretAccessKey: environment.S3_SECRET_ACCESS_KEY || "moroccoflow-local-secret",
      bucket: environment.S3_BUCKET || "moroccoflow-documents",
      forcePathStyle: environment.S3_FORCE_PATH_STYLE !== "false",
      serverSideEncryption:
        environment.S3_SERVER_SIDE_ENCRYPTION || (nodeEnv === "production" ? "AES256" : undefined),
    }),
  });
}
