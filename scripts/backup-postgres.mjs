import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const outputDirectory = path.resolve(process.env.BACKUP_DIR || "backups");
await mkdir(outputDirectory, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const output = path.join(outputDirectory, `moroccoflow-${stamp}.dump`);

await new Promise((resolve, reject) => {
  const child = spawn(
    "pg_dump",
    ["--dbname", databaseUrl, "--format=custom", "--compress=9", "--file", output],
    { stdio: "inherit", shell: false },
  );
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`pg_dump exited with code ${code}`)),
  );
});

const hash = createHash("sha256");
await new Promise((resolve, reject) => {
  createReadStream(output)
    .on("data", (chunk) => hash.update(chunk))
    .on("end", resolve)
    .on("error", reject);
});
const checksum = `${hash.digest("hex")}  ${path.basename(output)}\n`;
await writeFile(`${output}.sha256`, checksum, { encoding: "utf8", flag: "wx" });
process.stdout.write(`Backup created: ${output}\n`);
