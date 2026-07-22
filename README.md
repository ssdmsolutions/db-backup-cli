# db-backup-cli

Backs up a MySQL database running in a Docker container (via `docker exec mysqldump`),
uploads the compressed dump to any S3-compatible store (Cloudflare R2, Backblaze B2, AWS S3, ...),
and notifies by email + Telegram. Private, internal tool — not published to npm.

## Install (in a consuming project)

```bash
npm install git+https://github.com/<your-org>/db-backup-cli.git --save-dev
# or, without a remote yet, a local path during development:
npm install /path/to/db-backup-cli --save-dev
```

This exposes a `db-backup` binary via `npx db-backup <command>`.

## Commands

| Command | What it does |
|---|---|
| `db-backup dump` | Full backup: dump → verify → upload → prune old backups → email + Telegram notification (success or failure) |
| `db-backup 5min` | Frequent rolling backup, meant for a `*/N * * * *` cron. Silent on success; alerts Telegram immediately on failure |
| `db-backup 5min-summary` | Run once daily, shortly after midnight. Reports yesterday's rolling-backup count/size to Telegram, then deletes them |

All commands read config from `process.env`, loaded via `.env` in the current working directory by default.
Point elsewhere with `--env-file <path>`.

## Env vars

### Database (required for `dump` and `5min`)
```
DB_CONTAINER=my_mysql_container   # docker container name running MySQL
DB_NAME=my_database
DB_USER=root                      # optional, defaults to root
DB_PASSWORD=...                   # or set MYSQL_ROOT_PASSWORD instead
```

### Daily backup destination (required for `dump`)
```
S3_ENDPOINT=...                   # hostname only, no https://
S3_REGION=...
S3_KEY_ID=...
S3_SECRET_KEY=...
S3_BUCKET=...
S3_PREFIX=db-backups/             # optional
BACKUP_RETENTION_DAYS=14          # optional, 0 disables pruning
BACKUP_LINK_EXPIRY_SECONDS=259200 # optional, download link validity (max 604800 = 7 days)
```

### Rolling backup destination (required for `5min` and `5min-summary`)
```
S3_5MIN_ENDPOINT=...
S3_5MIN_REGION=...
S3_5MIN_KEY_ID=...
S3_5MIN_SECRET_KEY=...
S3_5MIN_BUCKET=...
S3_5MIN_PREFIX=5min-backups/       # optional
BACKUP_INTERVAL_MINUTES=5          # optional — only affects the "~N expected" figure in the summary
```

Can point at the same or a different S3-compatible account as the daily destination.

### Notifications (optional but recommended)
```
APP_LABEL=MyApp                    # tags notification subjects/messages, defaults to DB_NAME
BACKUP_NOTIFY_EMAILS=a@x.com,b@x.com
SMTP_HOST=...
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASSWORD=...
SMTP_FROM="Backups <backups@x.com>"
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...                # negative number for groups/supergroups
```

Any notification channel left unconfigured is skipped silently (with a console warning) —
safe to deploy before wiring up every channel.

## Crontab example

```
1 0 * * * cd /path/to/project && npx db-backup dump >> /var/log/db-backup.log 2>&1
*/5 * * * * cd /path/to/project && npx db-backup 5min >> /var/log/db-backup-5min.log 2>&1
5 0 * * * cd /path/to/project && npx db-backup 5min-summary >> /var/log/db-backup-5min.log 2>&1
```

## Design notes

- `dumpDatabase` waits for both the `docker exec` process's exit **and** the local write
  stream's actual `finish` event before considering the dump complete — resolving on process
  exit alone races with gzip's final flush and can silently upload a truncated file.
- Every dump is decompressed end-to-end (`verifyGzipIntegrity`) before upload, so a corrupt
  dump is reported as a failed backup rather than uploaded as if it succeeded.
