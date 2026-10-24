import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createDocsIndex,
  parseDoc,
  validateDocLinks,
} from "../../frontend/src/docs/model.ts";
import { docArticles } from "../../frontend/src/docs/manifest.ts";
import { createSearchAPI } from "fumadocs-core/search/server";

export function readArticles() {
  const index = createDocsIndex(
    Object.fromEntries(
      docArticles.map((article) => [
        article.slug,
        fs.readFileSync(
          new URL(
            `../../frontend/src/docs/articles/${article.slug}.md`,
            import.meta.url,
          ),
          "utf8",
        ),
      ]),
    ),
  );
  const errors = validateDocLinks(index);
  if (errors.length || index.length !== docArticles.length)
    throw new Error(
      "Documentation inventory/link validation failed: " + errors.join(", "),
    );
  return index;
}

export function searchIndexes() {
  return readArticles().map((article) => {
    let heading: string | undefined;
    const contents: { heading: string | undefined; content: string }[] = [];
    for (const token of article.tokens) {
      if (token.type === "heading") heading = token.anchor;
      else if (token.raw?.trim())
        contents.push({ heading, content: token.raw });
    }
    return {
      id: article.slug,
      url: "/docs/" + article.slug,
      title: article.title,
      breadcrumbs: [article.categoryTitle],
      locale: "id",
      structuredData: {
        headings: article.headings.map((h) => ({ id: h.id, content: h.text })),
        contents,
      },
    };
  });
}

export function createLocalSearch() {
  return createSearchAPI("advanced", { indexes: searchIndexes() });
}

/** Keep the existing fragments and treat all .md HTML as escaped text, never JSX. */
export function preserveMarkdown() {
  return (tree: any, file: any) => {
    const headings = parseDoc(String(file.value)).headings;
    let ordinal = 0;
    const visit = (node: any) => {
      if (/^mdx/.test(node.type))
        throw new Error(
          "Executable MDX nodes are not allowed in the public Markdown collection.",
        );
      if (node.type === "html") {
        node.type = "text";
        return;
      }
      if (node.type === "heading") {
        node.data ??= {};
        node.data.hProperties ??= {};
        node.data.hProperties.id = headings[ordinal++]?.id;
      }
      if (node.type === "code" && ["readonly", "review"].includes(node.meta)) {
        node.data ??= {};
        node.data.hProperties ??= {};
        node.data.hProperties["data-copy-policy"] = node.meta;
      }
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  };
}

export function removeBodyTitle() {
  return (tree: any, file: any) => {
    if (tree.children[0]?.type === "heading" && tree.children[0].depth === 1)
      tree.children.shift();
    if (Array.isArray(file.data.toc))
      file.data.toc = file.data.toc.filter((item: any) => item.depth > 1);
  };
}

/** Highlighting may replace code/pre properties. Apply the authored copy policy
 * after all highlighting plugins. Any structural mismatch fails the build for
 * a policy-bearing article instead of accidentally enabling mutation copying. */
export function preserveCodeCopyPolicy() {
  return (tree: any, file: any) => {
    const policies: (string | undefined)[] = [];
    const collect = (tokens: any[]) => {
      for (const token of tokens) {
        if (token.type === "code")
          policies.push(
            /^(?:bash|sh|text) (readonly|review)$/.exec(token.lang || "")?.[1],
          );
        if (token.tokens) collect(token.tokens);
        if (token.items) collect(token.items);
      }
    };
    collect(parseDoc(String(file.value)).tokens);
    if (!policies.some(Boolean)) return;
    const blocks: any[] = [];
    const visit = (node: any) => {
      if (node.type === "element" && node.tagName === "pre") blocks.push(node);
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
    if (blocks.length !== policies.length)
      throw new Error(
        "Documentation command copy policy could not be bound safely.",
      );
    blocks.forEach((block, index) => {
      if (policies[index]) {
        block.properties ??= {};
        block.properties["data-copy-policy"] = policies[index];
      }
    });
  };
}

export function publicArtifacts() {
  return {
    name: "pluton-public-docs-artifacts",
    async generateBundle(this: any) {
      const response = await createLocalSearch().staticGET();
      this.emitFile({
        type: "asset",
        fileName: "search-index.json",
        source: await response.text(),
      });
      const notices = [
        "fumadocs-core",
        "fumadocs-ui",
        "fumadocs-mdx",
        "react",
        "react-dom",
        "react-router",
        "next-themes",
        "tailwindcss",
        "lucide-react",
      ]
        .map((name) => {
          const directory = fileURLToPath(
            new URL(`../node_modules/${name}/`, import.meta.url),
          );
          // npm uses both LICENSE and license.md; Linux is case-sensitive.
          const license = fs
            .readdirSync(directory)
            .find((file) => /^license(?:\.(?:md|txt))?$/i.test(file));
          if (!license)
            throw new Error(`Missing public license notice for ${name}`);
          return (
            `\n=== ${name} ===\n` + fs.readFileSync(directory + license, "utf8")
          );
        })
        .join("\n");
      this.emitFile({
        type: "asset",
        fileName: "licenses/third-party.txt",
        source: notices,
      });
    },
  };
}
