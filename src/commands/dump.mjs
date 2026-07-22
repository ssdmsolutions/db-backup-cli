// Daily full backup: dump -> verify -> upload to S3-compatible storage ->
// prune old backups -> email + Telegram notification either way.
//
// Required env vars:
//   DB_CONTAINER, DB_NAME, DB_PASSWORD (or MYSQL_ROOT_PASSWORD)
//   S3_ENDPOINT, S3_REGION, S3_KEY_ID, S3_SECRET_KEY, S3_BUCKET
// Optional:
//   DB_USER (default root)
//   S3_PREFIX (default db-backups/), BACKUP_RETENTION_DAYS (default 14)
//   BACKUP_LINK_EXPIRY_SECONDS (default 259200 = 3 days, capped at 604800 by S3 itself)
//   APP_LABEL, BACKUP_NOTIFY_EMAILS, SMTP_*, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  dumpDatabase,
  verifyGzipIntegrity,
  requireEnv,
  readDbConfig,
  readNotifyConfig,
  notifyBoth,
} from "../lib.mjs";

export async function runDump(env) {
  // Computed up front (never throw) so the catch block below can always
  // notify — a config error (missing env var, bad password) is exactly the
  // kind of failure that must not fail silently.
  const notifyConfig = readNotifyConfig(env);
  const startedAt = new Date();
  let db;
  let localPath;

  try {
    requireEnv(env, ["DB_CONTAINER", "DB_NAME", "S3_ENDPOINT", "S3_REGION", "S3_KEY_ID", "S3_SECRET_KEY", "S3_BUCKET"]);

    db = readDbConfig(env);
    if (!db.dbPassword) {
      throw new Error("DB_PASSWORD (or MYSQL_ROOT_PASSWORD) is not set");
    }

    const prefix = env.S3_PREFIX || "db-backups/";
    const retentionDays = Number(env.BACKUP_RETENTION_DAYS || 14);
    const linkExpirySeconds = Number(env.BACKUP_LINK_EXPIRY_SECONDS || 259200);

    const timestamp = startedAt.toISOString().replace(/[:.]/g, "-");
    const fileName = `${db.dbName}-${timestamp}.sql.gz`;
    const tmpDir = path.join(os.tmpdir(), "db-backups");
    await mkdir(tmpDir, { recursive: true });
    localPath = path.join(tmpDir, fileName);

    const client = new S3Client({
      endpoint: `https://${env.S3_ENDPOINT}`,
      region: env.S3_REGION,
      credentials: { accessKeyId: env.S3_KEY_ID, secretAccessKey: env.S3_SECRET_KEY },
      forcePathStyle: true,
    });

    async function cleanupOld() {
      if (!retentionDays || retentionDays <= 0) return { deleted: [] };
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const list = await client.send(new ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: prefix }));
      const stale = (list.Contents || []).filter((o) => o.LastModified && o.LastModified.getTime() < cutoff);
      for (const obj of stale) {
        await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: obj.Key }));
      }
      return { deleted: stale.map((o) => o.Key) };
    }

    console.log(`Dumping ${db.dbName} from container ${db.container}...`);
    await dumpDatabase({ ...db, localPath });

    const { size } = await stat(localPath);
    if (size < 200) {
      throw new Error(`Dump file looks empty (${size} bytes) — aborting upload.`);
    }

    console.log("Verifying dump integrity...");
    await verifyGzipIntegrity(localPath);

    const key = `${prefix}${fileName}`;
    console.log(`Uploading ${fileName} (${(size / 1024 / 1024).toFixed(2)} MB) to ${env.S3_BUCKET}/${key}...`);
    await client.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: createReadStream(localPath) }));

    const { deleted } = await cleanupOld();
    await rm(localPath, { force: true });

    const downloadUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), {
      expiresIn: linkExpirySeconds,
    });
    const expiryHours = Math.round(linkExpirySeconds / 3600);
    const durationSec = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);

    const summary = [
      `✅ Database backup succeeded`,
      `Database: ${db.dbName}`,
      `File: ${key}`,
      `Size: ${(size / 1024 / 1024).toFixed(2)} MB`,
      `Duration: ${durationSec}s`,
      deleted.length ? `Pruned ${deleted.length} backup(s) older than ${retentionDays}d` : null,
      `Time: ${startedAt.toISOString()}`,
      `Download (expires in ${expiryHours}h): ${downloadUrl}`,
    ]
      .filter(Boolean)
      .join("\n");

    console.log(summary);
    await notifyBoth({ notifyConfig, subject: `[${notifyConfig.appLabel}] Database backup succeeded`, text: summary });
  } catch (err) {
    console.error("Backup failed:", err);
    const summary = [
      `❌ Database backup FAILED`,
      db?.dbName ? `Database: ${db.dbName}` : null,
      `Time: ${startedAt.toISOString()}`,
      `Error: ${err.message}`,
    ]
      .filter(Boolean)
      .join("\n");
    await notifyBoth({ notifyConfig, subject: `[${notifyConfig.appLabel}] Database backup FAILED`, text: summary });
    if (localPath) await rm(localPath, { force: true }).catch(() => {});
    throw err;
  }
}
