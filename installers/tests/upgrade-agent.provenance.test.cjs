"use strict";
// Read-only installer definitions and owned temporary trees only. No installer
// main(), service, enrollment, registry download, sudo or existing Agent access.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { verifiedInstallDigest } = require("../lib/upgrade-agent.cjs");
const diagnostics = require("../lib/upgrade-diagnostics.cjs");
const linux = process.platform === "linux";
const repository = path.resolve(__dirname, "../..");
const env = {
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  // Only changes expected ownership to this unprivileged disposable test's UID.
  PLUTON_AGENT_TEST_MODE: "1",
};
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function temporaryTree(t) {
  const parent = path.join(repository, "tmp/agent-upgrade");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "provenance-"));
  t.after(() => {
    assert(root.startsWith(parent + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const name of ["runtime/bin", "bin", "app/dist"])
    fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o755 });
  return root;
}

function entries(root) {
  const result = [];
  function visit(name) {
    const file = path.join(root, name),
      stat = fs.lstatSync(file);
    result.push({ name, file, stat });
    if (stat.isDirectory())
      for (const child of fs.readdirSync(file)) visit(`${name}/${child}`);
  }
  for (const name of ["runtime", "bin", "app"]) visit(name);
  return result.sort((a, b) =>
    Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
  );
}

// Independent legacy record-format oracle for synthetic fixtures. The actual
// Bash verifier is unchanged; this includes GNU sha256sum's backslash escaping.
function expectedDigest(root) {
  let records = "";
  for (const { name, file, stat } of entries(root)) {
    if (stat.isSymbolicLink())
      records += `link ${name} ${fs.readlinkSync(file)}\n`;
    else {
      records += `mode ${(stat.mode & 0o7777).toString(8)} ${name}\n`;
      if (stat.isFile()) {
        const escaped = name.includes("\\");
        records += `${escaped ? "\\" : ""}${sha(fs.readFileSync(file))}  ${name.replaceAll("\\", "\\\\")}\n`;
      }
    }
  }
  return sha(records);
}

function run(file, args, { failureCode, timeoutCode, ...options }) {
  try {
    return execFileSync(file, args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (raw) {
    throw diagnostics.commandFailure(raw, failureCode, timeoutCode);
  }
}

test(
  "Linux legacy tree record/hash format includes modes, links, spaces and escaped names",
  { skip: !linux },
  (t) => {
    const root = temporaryTree(t),
      file = path.join(root, "app/dist/index.js");
    fs.writeFileSync(file, "synthetic application", { mode: 0o644 });
    fs.writeFileSync(path.join(root, "runtime/bin/node"), "synthetic runtime", {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(root, "runtime/space μ\\header.h"),
      "synthetic header",
      { mode: 0o444 },
    );
    fs.symlinkSync("node", path.join(root, "runtime/bin/tool-link"));
    const metadata = path.join(root, ".verified-install");
    fs.writeFileSync(metadata, "format=1\nsource=unchanged\ntree=unchanged\n");
    const before = fs.readFileSync(metadata),
      digest = verifiedInstallDigest(run, repository, root);
    assert.equal(digest, expectedDigest(root));
    assert.equal(verifiedInstallDigest(run, repository, root), digest);
    assert.deepEqual(fs.readFileSync(metadata), before);
    fs.appendFileSync(file, "changed");
    assert.notEqual(verifiedInstallDigest(run, repository, root), digest);
  },
);

test(
  "Linux verifier still refuses unsafe permissions, outside/dangling links and control names",
  { skip: !linux },
  (t) => {
    const root = temporaryTree(t),
      file = path.join(root, "app/dist/index.js");
    fs.writeFileSync(file, "synthetic", { mode: 0o644 });
    const link = path.join(root, "bin/link");
    const cases = [
      [() => fs.chmodSync(file, 0o664), () => fs.chmodSync(file, 0o644)],
      [() => fs.symlinkSync("../outside", link), () => fs.unlinkSync(link)],
      [() => fs.symlinkSync("missing", link), () => fs.unlinkSync(link)],
      [
        () =>
          fs.writeFileSync(path.join(root, "app/control\nname"), "synthetic"),
        () => fs.unlinkSync(path.join(root, "app/control\nname")),
      ],
    ];
    fs.writeFileSync(path.join(root, "outside"), "unrelated synthetic bytes");
    for (const [change, restore] of cases) {
      change();
      try {
        assert.throws(
          () => verifiedInstallDigest(run, repository, root),
          (error) =>
            diagnostics.safeRecord(diagnostics.failureOf(error, "PROVENANCE"))
              .errorCode === "PROVENANCE_FAILED",
        );
      } finally {
        restore();
      }
    }
    assert.equal(
      fs.readFileSync(path.join(root, "outside"), "utf8"),
      "unrelated synthetic bytes",
    );
  },
);

test(
  "Linux many-file runtime/toolchain provenance benchmark retains exact digest within a finite budget",
  { skip: !linux },
  (t) => {
    const root = temporaryTree(t),
      runtime = path.join(root, "runtime");
    // Copy only known runtime components, never an entire /usr or an Agent tree.
    const node = fs.realpathSync(process.execPath),
      distribution = path.dirname(path.dirname(node));
    fs.copyFileSync(node, path.join(runtime, "bin/node"));
    fs.chmodSync(path.join(runtime, "bin/node"), 0o755);
    let corepack = false;
    for (const component of [
      "include/node",
      "lib/node_modules/corepack",
      "lib/node_modules/npm",
    ]) {
      const source = path.join(distribution, component);
      if (!fs.existsSync(source)) continue;
      fs.cpSync(source, path.join(runtime, component), {
        recursive: true,
        verbatimSymlinks: true,
      });
      if (component.endsWith("/corepack")) corepack = true;
    }
    if (corepack)
      fs.symlinkSync(
        "../lib/node_modules/corepack/dist/corepack.js",
        path.join(runtime, "bin/corepack"),
      );
    for (let i = 0; i < 88; i++)
      fs.writeFileSync(
        path.join(root, "app/dist", `module-${i}.js`),
        Buffer.alloc(7 * 1024, i),
      );
    fs.writeFileSync(
      path.join(root, "app/package.json"),
      '{"name":"synthetic-agent"}',
    );
    fs.writeFileSync(path.join(root, "bin/tool"), "synthetic private binary", {
      mode: 0o755,
    });
    const headers = path.join(runtime, "include/synthetic");
    fs.mkdirSync(headers, { recursive: true });
    const initialFiles = entries(root).filter(({ stat }) =>
      stat.isFile(),
    ).length;
    for (let i = initialFiles; i < 4096; i++)
      fs.writeFileSync(
        path.join(headers, `header-${i}.h`),
        `/* synthetic ${i} */\n`,
      );
    // Real written bytes, not a sparse/truncated file. At least 193 MiB of
    // runtime/application content, including this Node and available Corepack/npm.
    const contentBytes = entries(root).reduce(
      (total, { stat }) => total + (stat.isFile() ? stat.size : 0),
      0,
    );
    const padding = Math.max(0, 193 * 1024 * 1024 - contentBytes),
      fd = fs.openSync(path.join(runtime, "synthetic-payload"), "wx", 0o644);
    try {
      const chunk = Buffer.alloc(1024 * 1024, 0x5a);
      for (let remaining = padding; remaining > 0; remaining -= chunk.length)
        fs.writeSync(fd, chunk, 0, Math.min(remaining, chunk.length));
    } finally {
      fs.closeSync(fd);
    }
    const listing = entries(root),
      files = listing.filter(({ stat }) => stat.isFile()).length,
      dirs = listing.filter(({ stat }) => stat.isDirectory()).length,
      links = listing.filter(({ stat }) => stat.isSymbolicLink()).length;
    assert(files >= 4096);
    const sourceStart = performance.now();
    execFileSync(
      "/usr/bin/bash",
      [
        "-Eeuo",
        "pipefail",
        "-c",
        'source "$1/installers/install-agent.sh"',
        "source-only",
        repository,
      ],
      { env, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const sourceMs = performance.now() - sourceStart;
    const referenceStart = performance.now(),
      expected = expectedDigest(root),
      referenceMs = performance.now() - referenceStart;
    const originalStart = performance.now();
    let originalOutcome = "COMPLETE";
    try {
      assert.equal(
        verifiedInstallDigest(
          (file, args, options) =>
            run(file, args, { ...options, timeout: 30_000 }),
          repository,
          root,
        ),
        expected,
      );
    } catch (error) {
      // A fast runner may finish under the old deadline. A CPU-constrained
      // run can reproduce its failure; only a real deadline is accepted here.
      originalOutcome = diagnostics.safeRecord(
        diagnostics.failureOf(error, "PROVENANCE"),
      ).errorCode;
      assert.equal(originalOutcome, "PROVENANCE_TIMEOUT");
    }
    const originalMs = performance.now() - originalStart;
    const measurements = [];
    for (let i = 0; i < 2; i++) {
      const started = performance.now();
      // A stricter CI-only bound keeps a pathological benchmark from consuming
      // the whole job. Production's dedicated deadline remains five minutes.
      const digest = verifiedInstallDigest(
        (file, args, options) => {
          assert.equal(options.timeout, 300_000);
          return run(file, args, { ...options, timeout: 120_000 });
        },
        repository,
        root,
      );
      measurements.push(Math.round(performance.now() - started));
      assert.equal(digest, expected);
    }
    t.diagnostic(
      JSON.stringify({
        provenanceBenchmark: {
          platform: "linux",
          node: process.version,
          corepack,
          files,
          directories: dirs,
          links,
          bytes: contentBytes + padding,
          perEntryCommands: 3 * files + 2 * dirs + 3 * links,
          sourceMs: Math.round(sourceMs),
          referenceHashMs: Math.round(referenceMs),
          originalDeadline: {
            outcome: originalOutcome,
            elapsedMs: Math.round(originalMs),
          },
          scanMs: measurements,
        },
      }),
    );
  },
);
