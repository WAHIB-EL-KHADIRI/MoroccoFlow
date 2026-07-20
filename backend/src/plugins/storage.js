import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

export async function storagePlugin(app, options) {
  const { s3 } = options.config;
  const client = new S3Client({
    endpoint: s3.endpoint,
    region: s3.region,
    forcePathStyle: s3.forcePathStyle,
    credentials: {
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    },
  });
  if (!options.config.isProduction) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: s3.bucket }));
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 404 && error.name !== "NotFound") throw error;
      await client.send(new CreateBucketCommand({ Bucket: s3.bucket }));
    }
  }
  app.decorate("storage", client);
  app.addHook("onClose", async () => client.destroy());
}
