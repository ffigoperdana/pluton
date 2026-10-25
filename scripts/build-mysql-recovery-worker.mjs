import { createRequire } from "node:module";
import { writeFile, mkdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(
  new URL("../backend/package.json", import.meta.url),
);
const { build } = require("esbuild");
export function assertWorkerBundle(result) {
  // The client-only image has no native add-ons or application dependencies.
  // Inspect the actual graph, not source text/tree-shaking assumptions.
  if (
    Object.keys(result.metafile.inputs).some((file) =>
      /(?:^|[/\\])(?:better-sqlite3|bindings|file-uri-to-path)(?:[/\\@]|$)|\.node$/.test(
        file,
      ),
    ) ||
    result.outputFiles.some((file) => file.text.includes("Dynamic require of"))
  ) {
    throw new Error(
      "MySQL worker bundle contains an unsupported native/CommonJS runtime dependency.",
    );
  }
  for (const output of Object.values(result.metafile.outputs)) {
    if (
      output.imports.some(
        (value) =>
          value.external &&
          !builtinModules.includes(value.path.replace(/^node:/, "")),
      )
    )
      throw new Error(
        "MySQL worker bundle contains an external package dependency.",
      );
  }
}
export async function buildWorker() {
  const result = await build({
    entryPoints: ["backend/src/mysql-worker/index.ts"],
    outfile: "mysql-worker-dist/worker.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    metafile: true,
    write: false,
  });
  assertWorkerBundle(result);
  await mkdir("mysql-worker-dist", { recursive: true });
  for (const output of result.outputFiles)
    await writeFile(output.path, output.contents);
  return result;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildWorker();
