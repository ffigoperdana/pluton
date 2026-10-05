#!/usr/local/bin/node
import {
  readFileSync,
  existsSync,
  writeFileSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const state = dirname(dirname(process.env.RCLONE_CONFIG));
appendFileSync(join(state, "restic-calls"), JSON.stringify(args) + "\n");
const snapshot = join(state, "synthetic-snapshot.json");
if (args.includes("snapshots")) {
  console.log(existsSync(snapshot) ? readFileSync(snapshot, "utf8") : "[]");
} else if (args.includes("init")) {
  /* Success. */
} else if (args.includes("backup")) {
  if (existsSync(join(state, "fail-backup"))) process.exit(1);
  const relative = args[args.indexOf("backup") + 2];
  const file = relative?.startsWith("pluton/database/")
    ? join(process.cwd(), relative)
    : undefined;
  if (existsSync(join(process.cwd(), "database.cnf"))) process.exit(31);
  const tags = args.filter((_arg, index) => args[index - 1] === "--tag");
  const id = "a".repeat(64);
  const size = file ? statSync(file).size : 1;
  writeFileSync(snapshot, JSON.stringify([{ id, tags, size }]));
  console.log(
    JSON.stringify({
      message_type: "summary",
      snapshot_id: id,
      total_files_processed: file ? 2 : 1,
      total_bytes_processed: size,
    }),
  );
} else if (args.includes("ls")) {
  const data = JSON.parse(readFileSync(snapshot, "utf8"))[0];
  console.log(
    JSON.stringify({ type: "file", path: args.at(-1), size: data.size }),
  );
}
