// Runs once daily, shortly after midnight: reports yesterday's 5-min-backup
// count/size to Telegram (vs. the expected count for the configured
// interval), and permanently deletes every rolling backup from before today
// in S3-compatible storage — they're a short window for same-day recovery,
// superseded by the full daily backup from `dump.mjs`, so nothing is lost by
// purging them. Purging "everything before today" rather than just
// "yesterday" means a missed or failed run is caught up on the next one.
//
// Required env vars:
//   S3_5MIN_ENDPOINT, S3_5MIN_REGION, S3_5MIN_KEY_ID, S3_5MIN_SECRET_KEY, S3_5MIN_BUCKET
// Optional:
//   S3_5MIN_PREFIX (default 5min-backups/)
//   BACKUP_INTERVAL_MINUTES (default 5 — used only to compute the "~N expected" figure)
//   APP_LABEL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//
// `--dry-run` prints what would be purged, per day, without deleting
// anything or sending Telegram.

import { S3Client, ListObjectsV2Command, ListObjectVersionsCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { requireEnv, readNotifyConfig, sendTelegram, localDateString } from "../lib.mjs";

const DELETE_CONCURRENCY = 10;

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

// A plain DeleteObject on a versioned store (Backblaze B2 always; AWS S3 with
// versioning on) only *hides* the object behind a delete marker — the bytes
// stay stored and billed forever. Really freeing the space means deleting
// every version, and every marker, by VersionId. Stores without versioning
// (Cloudflare R2) reject ListObjectVersions as NotImplemented; a plain delete
// is already permanent there, so fall back to the current-object listing.
async function listAllVersions(client, bucket, prefix) {
  let items = [];
  let KeyMarker;
  let VersionIdMarker;
  try {
    do {
      const page = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, VersionIdMarker }));
      items = items.concat(page.Versions || [], (page.DeleteMarkers || []).map((m) => ({ ...m, isDeleteMarker: true })));
      KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (KeyMarker);
  } catch (err) {
    if (err.name !== "NotImplemented") throw err;
    return listAll(client, bucket, prefix);
  }
  return items;
}

async function deleteAll(client, bucket, items) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const { Key, VersionId } = items[next++];
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key, VersionId }));
    }
  }
  await Promise.all(Array.from({ length: DELETE_CONCURRENCY }, worker));
}

export async function runSummary5min(env, { dryRun = false } = {}) {
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

    // Runs right after midnight, so "yesterday" is the day whose backups need summarizing.
    // Built from calendar fields rather than `now - 24h` so a DST shift can't skip a day.
    const now = new Date();
    const todayStr = localDateString(now);
    const dateStr = localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    const dayPrefix = `${prefix}${dateStr}/`;

    const objects = await listAll(client, env.S3_5MIN_BUCKET, dayPrefix);
    const totalBytes = objects.reduce((sum, o) => sum + (o.Size || 0), 0);
    const expectedCount = Math.floor((24 * 60) / intervalMinutes);
    const shortfall = expectedCount - objects.length;

    // Only touch keys inside a `<prefix>YYYY-MM-DD/` folder dated before today —
    // never today's live window, and never anything else sharing the prefix.
    const dayFolderOf = (key) => /^(\d{4}-\d{2}-\d{2})\//.exec(key.slice(prefix.length))?.[1];
    const stale = (await listAllVersions(client, env.S3_5MIN_BUCKET, prefix)).filter((o) => {
      const day = dayFolderOf(o.Key);
      return day && day < todayStr;
    });
    const staleFiles = stale.filter((o) => !o.isDeleteMarker);
    const staleBytes = staleFiles.reduce((sum, o) => sum + (o.Size || 0), 0);
    const staleDays = new Set(stale.map((o) => dayFolderOf(o.Key))).size;

    if (!dryRun) await deleteAll(client, env.S3_5MIN_BUCKET, stale);

    const summary = [
      `🗄️ [${notifyConfig.appLabel}] 5-min backup summary — ${dateStr}`,
      `Backups taken: ${objects.length} / ~${expectedCount} expected`,
      shortfall > expectedCount * 0.1 ? `⚠️ ${shortfall} run(s) missing or failed — check logs` : null,
      `Total size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
      `${dryRun ? "Would purge" : "Purged"} ${staleFiles.length} file(s), ${(staleBytes / 1024 / 1024).toFixed(2)} MB, across ${staleDays} day(s) from storage (rolling window)`,
    ]
      .filter(Boolean)
      .join("\n");

    console.log(summary);
    if (dryRun) {
      const perDay = {};
      for (const o of staleFiles) perDay[dayFolderOf(o.Key)] = (perDay[dayFolderOf(o.Key)] || 0) + 1;
      for (const [day, count] of Object.entries(perDay).sort()) console.log(`  ${prefix}${day}/  ${count} file(s)`);
      console.log("[dry run] Nothing was deleted and no Telegram message was sent.");
      return;
    }
    await sendTelegram({ botToken: notifyConfig.telegramBotToken, chatId: notifyConfig.telegramChatId, text: summary });
  } catch (err) {
    console.error("5-min summary/cleanup failed:", err);
    if (dryRun) throw err;
    await sendTelegram({
      botToken: notifyConfig.telegramBotToken,
      chatId: notifyConfig.telegramChatId,
      text: `❌ [${notifyConfig.appLabel}] 5-min backup summary/cleanup FAILED\nError: ${err.message}`,
    });
    throw err;
  }
}
