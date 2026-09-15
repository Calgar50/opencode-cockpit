// curl-log.mjs - consigne les arguments recus (un tableau JSON par ligne), puis lance le vrai curl.exe avec les memes.
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
const log = process.env.COCKPIT_TEST_CURL_LOG;
if (log) appendFileSync(log, JSON.stringify(args) + "\n");
const real = join(process.env.SystemRoot ?? "C:/Windows", "System32", "curl.exe");
const run = spawnSync(real, args, { stdio: "inherit", windowsHide: true });
process.exit(run.status ?? 1);
