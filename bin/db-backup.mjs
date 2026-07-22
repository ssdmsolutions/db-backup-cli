#!/usr/bin/env node
import dotenv from "dotenv";
import path from "node:path";
import { runDump } from "../src/commands/dump.mjs";
import { runDump5min } from "../src/commands/dump5min.mjs";
import { runSummary5min } from "../src/commands/summary5min.mjs";

const args = process.argv.slice(2);
const command = args[0];

const envFileIdx = args.indexOf("--env-file");
const envFile = envFileIdx !== -1 ? args[envFileIdx + 1] : path.join(process.cwd(), ".env");
dotenv.config({ path: envFile });

const commands = {
  dump: runDump,
  "5min": runDump5min,
  "5min-summary": runSummary5min,
};

function printUsage() {
  console.log(`Usage: db-backup <command> [--env-file <path>]

Commands:
  dump           Full backup: dump -> upload -> prune -> notify (email + Telegram)
  5min           Frequent rolling backup: dump -> upload; silent on success, alerts on failure
  5min-summary   Daily summary + purge of the rolling backups (run once, shortly after midnight)

Config is read from process.env, loaded from --env-file (default: ./.env in the current directory).
See README.md for the full list of env vars.`);
}

if (!command || !commands[command]) {
  printUsage();
  process.exit(command ? 1 : 0);
}

commands[command](process.env)
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
