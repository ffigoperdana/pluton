/** Pure v1 exclusion contract. Server, Agent and browser copies are checked by
 * the cross-package contract regression; no filesystem or shell evaluation. */
function unsafeControls(value: string): boolean {
  return [...value].some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  );
}

export function parseBackupExclusions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Backup Exclusions must contain at most 100 patterns.");
  let units = 0;
  return [
    ...new Set(
      value.map((item: unknown, index: number) => {
        if (typeof item !== "string" || unsafeControls(item))
          throw new Error("Invalid Backup Exclusions.");
        const pattern = item.trim().replace(/\/$/, "");
        units += pattern.length;
        const parts = pattern.split("/");
        const effective = [...parts];
        while (effective.length > 1 && effective[effective.length - 1] === "**")
          effective.pop();
        if (
          !pattern ||
          pattern.length > 512 ||
          units > 16384 ||
          effective.filter((part) => part === "**").length > 1 ||
          parts.some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              !/^[\p{L}\p{N}._ *?+-]+$/u.test(part) ||
              (part.includes("**") && part !== "**"),
          )
        )
          throw new Error(
            `Invalid Backup Exclusions pattern ${index + 1}. Use relative paths, *, ?, and at most one whole-component recursive ** (optional trailing /**).`,
          );
        return pattern;
      }),
    ),
  ];
}

function segmentMatches(pattern: string, value: string): boolean {
  const tokens = [...pattern],
    chars = [...value];
  let p = 0,
    v = 0,
    star = -1,
    retry = 0;
  while (v < chars.length) {
    if (tokens[p] === "?" || tokens[p] === chars[v]) {
      p++;
      v++;
    } else if (tokens[p] === "*") {
      star = p++;
      retry = v;
    } else if (star >= 0) {
      p = star + 1;
      v = ++retry;
    } else return false;
  }
  while (tokens[p] === "*") p++;
  return p === tokens.length;
}

function pathMatches(pattern: string, relative: string): boolean {
  const tokens = pattern.split("/");
  let states = new Set([0]);
  const expand = (positions: Set<number>) => {
    for (const index of positions)
      if (tokens[index] === "**") positions.add(index + 1);
    return positions;
  };
  expand(states);
  for (const part of relative.split("/")) {
    const next = new Set<number>();
    for (const index of states) {
      if (tokens[index] === "**") next.add(index);
      else if (tokens[index] && segmentMatches(tokens[index], part))
        next.add(index + 1);
    }
    states = expand(next);
    if (states.has(tokens.length)) return true; // A matched ancestor prunes the subtree.
    if (!states.size) return false;
  }
  return false;
}

/** Bare names match at any depth; slash patterns start at the selected source.
 * Trailing / is ignored, exactly as in Restic (all entry types, not dirs only). */
export function compileBackupExclusions(
  patterns: string[],
): (relative: string) => boolean {
  const scoped = parseBackupExclusions(patterns).map((pattern) =>
    pattern.includes("/") ? pattern : `**/${pattern}`,
  );
  return (relative) => {
    if (
      !relative ||
      relative.startsWith("/") ||
      relative.split("/").some((part) => part === "..")
    )
      return false;
    return scoped.some((pattern) => pathMatches(pattern, relative)); // No regex backtracking.
  };
}

export function backupExclusionMatches(
  patterns: string[],
  relative: string,
): boolean {
  return compileBackupExclusions(patterns)(relative);
}

/** Anchor every user filter to the canonical source. Never filter the separate
 * lifecycle workspace containing SQL dumps, manifests, or private credentials. */
export function sourceResticExclusions(
  source: string,
  patterns: string[],
): string[] {
  if (
    !source.startsWith("/") ||
    unsafeControls(source) ||
    ["*", "?", "[", "]", "\\"].some((char) => source.includes(char)) ||
    source.split("/").includes("..")
  )
    throw new Error(
      "The source path cannot be safely anchored for Backup Exclusions.",
    );
  return parseBackupExclusions(patterns).map((pattern) => {
    const parts = (pattern.includes("/") ? pattern : `**/${pattern}`).split(
      "/",
    );
    // Restic can retain a directory entry with a trailing /**. Our contract
    // prunes a matched subtree, so exclude its root while preserving the
    // original anchoring (node_modules/** is NOT a bare any-depth name).
    while (parts.length > 1 && parts[parts.length - 1] === "**") parts.pop();
    return `${source.replace(/\/$/, "")}/${parts.join("/")}`;
  });
}
