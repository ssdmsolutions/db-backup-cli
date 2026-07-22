// Correctness-sensitive core shared by every command. Keep dump/verify logic
// here rather than duplicated per command — it contains a fix for a real
// truncated-gzip race condition that must not drift between commands.

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { createGzip, createGunzip } from "node:zlib";
import nodemailer from "nodemailer";

export function dumpDatabase({ container, dbUser, dbPassword, dbName, localPath }) {
  return new Promise((resolve, reject) => {
    const dump = spawn(
      "docker",
      [
        "exec",
        "-e",
        `MYSQL_PWD=${dbPassword}`,
        container,
        "mysqldump",
        "-u",
        dbUser,
        "--single-transaction",
        "--quick",
        "--routines",
        "--triggers",
        "--events",
        dbName,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    dump.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const gzip = createGzip();
    const out = createWriteStream(localPath);

    dump.stdout.pipe(gzip).pipe(out);

    // The child process's `close` event only tells us mysqldump finished
    // sending data — it says nothing about whether the downstream gzip
    // transform has flushed its final compressed bytes (incl. the gzip
    // trailer) to disk. Resolving on `close` alone races with that flush and
    // can upload a truncated .gz file. Wait for BOTH signals before settling.
    let dumpExitCode = null;
    let outFinished = false;
    let failure = null;

    function settle() {
      if (failure) {
        reject(failure);
        return;
      }
      if (dumpExitCode === null || !outFinished) return;
      if (dumpExitCode !== 0) {
        reject(new Error(`mysqldump exited with code ${dumpExitCode}: ${stderr.trim()}`));
      } else {
        resolve();
      }
    }

    dump.on("error", (err) => {
      failure = err;
      settle();
    });
    dump.stdout.on("error", (err) => {
      failure = err;
      settle();
    });
    gzip.on("error", (err) => {
      failure = err;
      settle();
    });
    out.on("error", (err) => {
      failure = err;
      settle();
    });

    dump.on("close", (code) => {
      dumpExitCode = code;
      settle();
    });
    out.on("finish", () => {
      outFinished = true;
      settle();
    });
  });
}

// Decompresses the dump end-to-end so a truncated/corrupt .gz file is caught
// here and reported as a failed backup, instead of being silently uploaded
// as if it succeeded.
export function verifyGzipIntegrity(filePath) {
  return new Promise((resolve, reject) => {
    let bytesOut = 0;
    createReadStream(filePath)
      .pipe(createGunzip())
      .on("data", (chunk) => {
        bytesOut += chunk.length;
      })
      .on("error", (err) => reject(new Error(`Backup file failed integrity check: ${err.message}`)))
      .on("end", () => {
        if (bytesOut === 0) {
          reject(new Error("Backup file failed integrity check: decompressed to 0 bytes"));
        } else {
          resolve();
        }
      });
  });
}

export async function sendEmail({ smtp, to, subject, text }) {
  if (!to.length) return;
  if (!smtp.host) {
    console.warn("SMTP_HOST not set — skipping email notification.");
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port),
      secure: smtp.secure === "true",
      auth: { user: smtp.user, pass: smtp.password },
    });
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to: to.join(","),
      subject,
      text,
    });
  } catch (err) {
    console.error("Failed to send backup email notification:", err);
  }
}

export async function sendTelegram({ botToken, chatId, text }) {
  if (!botToken || !chatId) {
    console.warn("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — skipping Telegram notification.");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      console.error("Telegram notification failed:", res.status, await res.text());
    }
  } catch (err) {
    console.error("Failed to send Telegram notification:", err);
  }
}

export function localDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function requireEnv(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) {
    throw new Error(`Missing required env var(s): ${missing.join(", ")}`);
  }
}

export function readDbConfig(env) {
  return {
    container: env.DB_CONTAINER,
    dbName: env.DB_NAME,
    dbUser: env.DB_USER || "root",
    dbPassword: env.DB_PASSWORD || env.MYSQL_ROOT_PASSWORD,
  };
}

export function readNotifyConfig(env) {
  return {
    appLabel: env.APP_LABEL || env.DB_NAME || "app",
    notifyEmails: (env.BACKUP_NOTIFY_EMAILS || "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean),
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.SMTP_FROM,
    },
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
  };
}

export async function notifyBoth({ notifyConfig, subject, text }) {
  await Promise.all([
    sendEmail({ smtp: notifyConfig.smtp, to: notifyConfig.notifyEmails, subject, text }),
    sendTelegram({ botToken: notifyConfig.telegramBotToken, chatId: notifyConfig.telegramChatId, text }),
  ]);
}
