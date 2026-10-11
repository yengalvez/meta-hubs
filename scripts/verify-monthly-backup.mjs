#!/usr/bin/env node
import { runMonthlyVerification } from "../deployment/monthly-verification.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--evidence-dir") {
  process.stderr.write("Usage: node scripts/verify-monthly-backup.mjs --evidence-dir ABSOLUTE_EMPTY_PRIVATE_DIRECTORY\n");
  process.exitCode = 2;
} else {
  try {
    const monthly = await runMonthlyVerification({ evidenceDirectory: args[1],
      progress: id => process.stderr.write(`Monthly verification: ${id}\n`) });
    process.stdout.write(JSON.stringify({ state: "verified-not-restore-accepted", monthly }) + "\n");
  } catch (error) {
    process.stderr.write(`Monthly verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
