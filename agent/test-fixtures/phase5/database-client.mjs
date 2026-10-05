#!/usr/local/bin/node
// Synthetic executable fixture; never connects to a database.
import { basename, dirname, join } from "node:path";
import { readFileSync, statSync, appendFileSync, symlinkSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log(
    basename(process.argv[1]) === "mariadb-dump"
      ? "mariadb-dump Ver 10.19 Distrib 10.11.6-MariaDB"
      : "mysqldump Ver 8.0.40 for Linux",
  );
} else {
  const defaults = args[0]?.replace(/^--defaults-file=/, "");
  const config = readFileSync(defaults, "utf8");
  const workspace = dirname(defaults);
  if (
    (statSync(defaults).mode & 0o777) !== 0o600 ||
    (statSync(workspace).mode & 0o777) !== 0o700
  )
    process.exit(22);
  if (args.some((value) => /password=|test-only-db-secret/.test(value)))
    process.exit(23);
  if (
    process.env.SECRET ||
    process.env.MYSQL_PWD ||
    process.env.RESTIC_PASSWORD ||
    process.env.RCLONE_CONFIG
  )
    process.exit(24);
  if (
    process.env.HOME !== join(workspace, "client-home") ||
    process.env.MYSQL_TEST_LOGIN_FILE !==
      join(workspace, "client-home", ".mylogin.cnf")
  )
    process.exit(26);
  if (
    !args.includes("--single-transaction") ||
    !args.includes("--skip-lock-tables")
  )
    process.exit(25);
  appendFileSync(
    join(dirname(dirname(workspace)), "dump-calls"),
    JSON.stringify({
      workspace,
      mode: statSync(defaults).mode & 0o777,
      args,
      engine: basename(process.argv[1]),
      escaped: config.includes('password="'),
    }) + "\n",
  );
  const database = args.at(-1);
  if (database === "auth_failure") {
    console.error(
      "1045 Access denied (test-only-db-secret must never leave classifier)",
    );
    process.exitCode = 2;
  } else if (database === "unavailable") {
    console.error("2003 Can't connect: synthetic provider text");
    process.exitCode = 2;
  } else if (database === "slow_dump") {
    setInterval(() => {}, 1000);
  } else if (database === "oversize") {
    process.stdout.write("x".repeat(4096));
  } else if (database === "empty_dump") {
    /* Invalid successful empty output. */
  } else if (database === "symlink_dump") {
    symlinkSync(
      "/etc/passwd",
      join(workspace, "pluton", "database", "escape.sql"),
    );
    process.stdout.write("-- synthetic dump\n");
  } else {
    process.stdout.write(
      "-- synthetic SQL fixture\nCREATE TABLE example (id INT);\nINSERT INTO example VALUES (1);\n",
    );
  }
}
