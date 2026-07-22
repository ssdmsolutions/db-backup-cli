// Runs once daily, shortly after midnight: reports yesterday's 5-min-backup
// count/size to Telegram (vs. the expected count for the configured
// interval), THEN deletes that day's rolling backups from S3-compatible
// storage — they're a short window for same-day recovery, superseded by the
// full daily backup from `dump.mjs`, so nothing is lost by purging them.
//
// Required env vars:
//   S3_5MIN_ENDPOINT, S3_5MIN_REGION, S3_5MIN_KEY_ID, S3_5MIN_SECRET_KEY, S3_5MIN_BUCKET
// Optional:
//   S3_5MIN_PREFIX (default 5min-backups/)
//   BACKUP_INTERVAL_MINUTES (default 5 — used only to compute the "~N expected" figure)
//   APP_LABEL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { requireEnv, readNotifyConfig, sendTelegram, localDateString } from "../lib.mjs";

async function listAll(client, bucket, prefix) {
  let items = [];
  let ContinuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    items = items.concat(page.Contents || []);
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return items;
}

export async function runSummary5min(env) {
  // Computed up front (never throws) so the catch block below can always
  // alert — a config error (missing env var) is exactly the kind of failure
  // that must not fail silently.
  const notifyConfig = readNotifyConfig(env);

  try {
    requireEnv(env, ["S3_5MIN_ENDPOINT", "S3_5MIN_REGION", "S3_5MIN_KEY_ID", "S3_5MIN_SECRET_KEY", "S3_5MIN_BUCKET"]);

    const prefix = env.S3_5MIN_PREFIX || "5min-backups/";
    const intervalMinutes = Number(env.BACKUP_INTERVAL_MINUTES || 5);

    const client = new S3Client({
      endpoint: `https://${env.S3_5MIN_ENDPOINT}`,
      region: env.S3_5MIN_REGION,
      credentials: { accessKeyId: env.S3_5MIN_KEY_ID, secretAccessKey: env.S3_5MIN_SECRET_KEY },
      forcePathStyle: true,
    });

    // Runs right after midnight, so "yesterday" is the day whose backups need summarizing/purging.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dateStr = localDateString(yesterday);
    const dayPrefix = `${prefix}${dateStr}/`;

    const objects = await listAll(client, env.S3_5MIN_BUCKET, dayPrefix);
    const totalBytes = objects.reduce((sum, o) => sum + (o.Size || 0), 0);
    const expectedCount = Math.floor((24 * 60) / intervalMinutes);
    const shortfall = expectedCount - objects.length;

    const summary = [
      `🗄️ [${notifyConfig.appLabel}] 5-min backup summary — ${dateStr}`,
      `Backups taken: ${objects.length} / ~${expectedCount} expected`,
      shortfall > expectedCount * 0.1 ? `⚠️ ${shortfall} run(s) missing or failed — check logs` : null,
      `Total size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
      `Deleting ${objects.length} file(s) from storage (rolling window)...`,
    ]
      .filter(Boolean)
      .join("\n");

    console.log(summary);
    await sendTelegram({ botToken: notifyConfig.telegramBotToken, chatId: notifyConfig.telegramChatId, text: summary });

    for (const obj of objects) {
      await client.send(new DeleteObjectCommand({ Bucket: env.S3_5MIN_BUCKET, Key: obj.Key }));
    }
  } catch (err) {
    console.error("5-min summary/cleanup failed:", err);
    await sendTelegram({
      botToken: notifyConfig.telegramBotToken,
      chatId: notifyConfig.telegramChatId,
      text: `❌ [${notifyConfig.appLabel}] 5-min backup summary/cleanup FAILED\nError: ${err.message}`,
    });
    throw err;
  }
}
