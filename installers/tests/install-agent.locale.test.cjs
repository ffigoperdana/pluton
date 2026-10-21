"use strict";
// Disposable unprivileged Linux trees only; source definitions, never installer main().
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { verifiedInstallDigest } = require("../lib/upgrade-agent.cjs");
const repository = path.resolve(__dirname, "../..");
const linux = process.platform === "linux";
const env = {
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  PLUTON_AGENT_TEST_MODE: "1",
  ...(process.env.LOCPATH ? { LOCPATH: process.env.LOCPATH } : {}),
};
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function bash(code, args, locale) {
  return execFileSync(
    "/usr/bin/bash",
    ["-Eeuo", "pipefail", "-c", code, "locale-fixture", repository, ...args],
    {
      env: { ...env, ...locale },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}
function digest(root, locale) {
  return bash(
    'source "$1/installers/install-agent.sh"; verified_tree_digest "$2"',
    [root],
    locale,
  );
}
function tree(t) {
  const parent = path.join(repository, "tmp/agent-upgrade");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "locale-"));
  t.after(() => {
    assert(root.startsWith(parent + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const name of [
    "runtime/bin",
    "bin",
    "app/dist/Nested",
    "app/dist/nested",
  ])
    fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o755 });
  for (const name of [
    "A",
    "a",
    "Z",
    "z",
    ".hidden",
    "é",
    "μ",
    "space name",
    "punctuation_+-",
    "Nested/X",
    "nested/x",
  ])
    fs.writeFileSync(path.join(root, "app/dist", name), `synthetic ${name}`, {
      mode: 0o644,
    });
  fs.writeFileSync(path.join(root, "runtime/bin/node"), "synthetic runtime", {
    mode: 0o755,
  });
  fs.symlinkSync("../runtime/bin/node", path.join(root, "bin/tool"));
  return root;
}
// Independent legacy C-order serialization. Does not call the Bash digest algorithm.
function legacyCDigest(root) {
  const names = [];
  function visit(relative) {
    names.push(relative);
    if (fs.lstatSync(path.join(root, relative)).isDirectory())
      for (const name of fs.readdirSync(path.join(root, relative)))
        visit(`${relative}/${name}`);
  }
  for (const name of ["runtime", "bin", "app"]) visit(name);
  names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  let records = "";
  for (const name of names) {
    const file = path.join(root, name),
      stat = fs.lstatSync(file);
    if (stat.isSymbolicLink())
      records += `link ${name} ${fs.readlinkSync(file)}\n`;
    else {
      records += `mode ${(stat.mode & 0o7777).toString(8)} ${name}\n`;
      if (stat.isFile()) records += `${sha(fs.readFileSync(file))}  ${name}\n`;
    }
  }
  return sha(records);
}
function available(locale) {
  try {
    return (
      execFileSync("locale", ["charmap"], {
        env: { ...env, LC_ALL: locale },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() === (locale === "C" ? "ANSI_X3.4-1968" : "UTF-8")
    );
  } catch {
    return false;
  }
}
const unicodeLocales = linux
  ? ["C.UTF-8", "en_US.UTF-8"].filter(available)
  : [];

test(
  "Linux integrity and source fingerprints retain legacy C bytes across locales and precedence without leaking locale to caller",
  { skip: !linux },
  async (t) => {
    if (process.env.PLUTON_REQUIRE_LOCALE_TESTS === "1")
      assert(
        unicodeLocales.includes("en_US.UTF-8"),
        "CI must provide a real en_US.UTF-8 locale",
      );
    const root = tree(t),
      expected = legacyCDigest(root);
    const source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "agent/src"), { recursive: true });
    for (const file of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "agent/package.json",
      "agent/tsconfig.json",
      "agent/src/A.ts",
      "agent/src/a.ts",
      "agent/src/.hidden.ts",
      "agent/src/é.ts",
    ])
      fs.writeFileSync(path.join(source, file), `synthetic ${file}`);
    const sourceHash = (locale) =>
      bash(
        'source "$1/installers/install-agent.sh"; REPOSITORY_ROOT="$2"; source_fingerprint',
        [source],
        locale,
      );
    const expectedSource = sourceHash({ LC_ALL: "C" });
    fs.writeFileSync(
      path.join(root, ".verified-install"),
      `format=1\nsource=${expectedSource}\ntree=${expected}\n`,
      { mode: 0o644 },
    );
    const metadata = fs.readFileSync(path.join(root, ".verified-install"));
    for (const locale of ["C", "C.UTF-8", "en_US.UTF-8"]) {
      await t.test(
        locale,
        { skip: locale !== "C" && !unicodeLocales.includes(locale) },
        () => {
          for (const settings of [
            { LANG: locale },
            { LANG: "C", LC_COLLATE: locale },
            { LANG: "C", LC_ALL: locale, LC_COLLATE: "C" },
          ]) {
            assert.equal(digest(root, settings), expected);
            assert.equal(sourceHash(settings), expectedSource);
            const before = JSON.stringify(settings);
            bash(
              'source "$1/installers/install-agent.sh"; prior="${LANG-}:${LC_ALL-}:${LC_COLLATE-}"; verified_tree_digest "$2" >/dev/null; [[ "$prior" == "${LANG-}:${LC_ALL-}:${LC_COLLATE-}" ]]',
              [root],
              settings,
            );
            assert.equal(JSON.stringify(settings), before);
          }
        },
      );
    }
    assert.deepEqual(
      fs.readFileSync(path.join(root, ".verified-install")),
      metadata,
    );
    t.diagnostic(
      JSON.stringify({
        testedLocales: ["C", ...unicodeLocales],
        legacyFormat: 1,
        canonicalDigest: expected,
      }),
    );
  },
);

test(
  "Linux upgrade provenance verification never rewrites mismatches or changes original artifacts",
  { skip: !linux },
  (t) => {
    const root = tree(t),
      locale = { LANG: "C", LC_ALL: unicodeLocales.at(-1) || "C" };
    const expected = legacyCDigest(root),
      metadata = path.join(root, ".verified-install");
    fs.writeFileSync(metadata, `format=1\ntree=${expected}\n`, { mode: 0o644 });
    const original = fs.readFileSync(metadata),
      stat = fs.statSync(metadata);
    const check = () =>
      bash(
        'source "$1/installers/install-agent.sh"; tree="$(verified_tree_digest "$2")"; grep -Fx "tree=$tree" "$2/.verified-install" >/dev/null',
        [root],
        locale,
      );
    check();
    const run = (file, args, options) =>
      execFileSync(file, args, {
        env: { ...env, ...locale },
        encoding: "utf8",
        timeout: options.timeout,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    assert.equal(verifiedInstallDigest(run, repository, root), expected);
    const file = path.join(root, "app/dist/A"),
      link = path.join(root, "bin/tool");
    const content = fs.readFileSync(file);
    for (const [mutate, restore] of [
      [
        () => fs.appendFileSync(file, "changed"),
        () => fs.writeFileSync(file, content),
      ],
      [() => fs.chmodSync(file, 0o600), () => fs.chmodSync(file, 0o644)],
      [
        () => fs.chmodSync(path.join(root, "app/dist"), 0o700),
        () => fs.chmodSync(path.join(root, "app/dist"), 0o755),
      ],
      [
        () => {
          fs.unlinkSync(link);
          fs.symlinkSync("../app/dist/a", link);
        },
        () => {
          fs.unlinkSync(link);
          fs.symlinkSync("../runtime/bin/node", link);
        },
      ],
      [() => fs.chmodSync(file, 0o664), () => fs.chmodSync(file, 0o644)],
    ]) {
      mutate();
      try {
        assert.throws(check);
        assert.deepEqual(fs.readFileSync(metadata), original);
      } finally {
        restore();
      }
      check();
    }
    const after = fs.statSync(metadata);
    assert.equal(after.ino, stat.ino);
    assert.equal(after.mtimeMs, stat.mtimeMs);
    assert.deepEqual(fs.readFileSync(file), content);
    assert.equal(fs.readlinkSync(link), "../runtime/bin/node");
  },
);
