// Frequent rolling backup, meant to run every few minutes via cron. Silent
// on success (avoid notification spam at high frequency); alerts Telegram
// immediately on failure, since staying silent until the daily summary could
// hide a real problem for up to 24h.
//
// Required env vars:
//   DB_CONTAINER, DB_NAME, DB_PASSWORD (or MYSQL_ROOT_PASSWORD)
//   S3_5MIN_ENDPOINT, S3_5MIN_REGION, S3_5MIN_KEY_ID, S3_5MIN_SECRET_KEY, S3_5MIN_BUCKET
// Optional:
//   DB_USER (default root), S3_5MIN_PREFIX (default 5min-backups/)
//   APP_LABEL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { dumpDatabase, verifyGzipIntegrity, requireEnv, readDbConfig, readNotifyConfig, sendTelegram, localDateString } from "../lib.mjs";

export async function runDump5min(env) {
  // Computed up front (never throw) so the catch block below can always
  // alert — a config error (missing env var, bad password) is exactly the
  // kind of failure that must not fail silently.
  const notifyConfig = readNotifyConfig(env);
  const startedAt = new Date();
  let db;
  let localPath;

  try {
    requireEnv(env, ["DB_CONTAINER", "DB_NAME", "S3_5MIN_ENDPOINT", "S3_5MIN_REGION", "S3_5MIN_KEY_ID", "S3_5MIN_SECRET_KEY", "S3_5MIN_BUCKET"]);

    db = readDbConfig(env);
    if (!db.dbPassword) {
      throw new Error("DB_PASSWORD (or MYSQL_ROOT_PASSWORD) is not set");
    }

    const prefix = env.S3_5MIN_PREFIX || "5min-backups/";
    const timestamp = startedAt.toISOString().replace(/[:.]/g, "-");
    const fileName = `${db.dbName}-${timestamp}.sql.gz`;
    const tmpDir = path.join(os.tmpdir(), "db-backups-5min");
    await mkdir(tmpDir, { recursive: true });
    localPath = path.join(tmpDir, fileName);

    await dumpDatabase({ ...db, localPath });

    const { size } = await stat(localPath);
    if (size < 200) {
      throw new Error(`Dump file looks empty (${size} bytes) — aborting upload.`);
    }

    await verifyGzipIntegrity(localPath);

    const key = `${prefix}${localDateString(startedAt)}/${fileName}`;
    const client = new S3Client({
      endpoint: `https://${env.S3_5MIN_ENDPOINT}`,
      region: env.S3_5MIN_REGION,
      credentials: { accessKeyId: env.S3_5MIN_KEY_ID, secretAccessKey: env.S3_5MIN_SECRET_KEY },
      forcePathStyle: true,
    });
    await client.send(new PutObjectCommand({ Bucket: env.S3_5MIN_BUCKET, Key: key, Body: createReadStream(localPath) }));

    await rm(localPath, { force: true });
    console.log(`OK — uploaded ${key} (${(size / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.error("5-min backup failed:", err);
    await sendTelegram({
      botToken: notifyConfig.telegramBotToken,
      chatId: notifyConfig.telegramChatId,
      text: [
        `⚠️ [${notifyConfig.appLabel}] 5-min database backup FAILED`,
        db?.dbName ? `Database: ${db.dbName}` : null,
        `Time: ${startedAt.toISOString()}`,
        `Error: ${err.message}`,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    if (localPath) await rm(localPath, { force: true }).catch(() => {});
    throw err;
  }
}
