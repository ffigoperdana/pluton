import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const source = (file) =>
  ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
const walk = (node, callback) => {
  callback(node);
  ts.forEachChild(node, (child) => walk(child, callback));
};
const text = (node) => node?.getText() || "";
const literal = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
const join = (a, b) =>
  `${a}/${b}`.replaceAll(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
const files = (directory) =>
  fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(`${directory}/${entry.name}`)
        : [`${directory}/${entry.name}`],
    );
const tests = files("backend/__tests__")
  .filter((file) => /\.(test|integration)\.ts$/.test(file))
  .map((file) => ({ file, body: read(file) }));
const app = source("backend/src/createApp.ts");
const factories = new Map();
walk(app, (node) => {
  if (
    ts.isImportDeclaration(node) &&
    literal(node.moduleSpecifier)?.startsWith("./routes/")
  )
    for (const element of node.importClause?.namedBindings?.elements || [])
      factories.set(
        element.name.text,
        literal(node.moduleSpecifier).replace("./", "backend/src/") + ".ts",
      );
});
const mounts = new Map();
walk(app, (node) => {
  if (!ts.isCallExpression(node) || text(node.expression) !== "app.use") return;
  const mount = literal(node.arguments[0]);
  if (!mount) return;
  for (const arg of node.arguments.slice(1))
    if (ts.isCallExpression(arg) && factories.has(text(arg.expression)))
      mounts.set(factories.get(text(arg.expression)), mount);
});
const legacyAllowed = new Set([
  "GET /api/plans",
  "GET /api/storages",
  "GET /api/devices",
  "GET /api/health",
  "POST /api/plans",
]);
const controllerMethods = new Map();
for (const file of files("backend/src/controllers").filter((file) =>
  file.endsWith(".ts"),
))
  walk(source(file), (node) => {
    if (ts.isClassDeclaration(node) && node.name)
      for (const member of node.members)
        if (ts.isMethodDeclaration(member))
          controllerMethods.set(`${node.name.text}.${text(member.name)}`, {
            file,
            body: text(member),
          });
  });
function schemaHints(body) {
  return [
    ...new Set(
      [...body.matchAll(/\b[A-Za-z][A-Za-z0-9_]*(?:Schema|schema)\b/g)].map(
        (match) => match[0],
      ),
    ),
  ].slice(0, 10);
}
export function inventory() {
  const entries = [];
  for (const [file, mount] of mounts) {
    const ast = source(file),
      body = read(file);
    let controller = "";
    walk(ast, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        literal(node.moduleSpecifier)?.includes("/controllers/")
      )
        controller =
          node.importClause?.namedBindings?.elements?.[0]?.name.text || "";
    });
    walk(ast, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !/^router\.(get|head|post|put|delete|patch|all)$/.test(text(node.expression))
      )
        return;
      const method = text(node.expression).split(".")[1].toUpperCase();
      let routes = [literal(node.arguments[0])];
      if (
        routes[0] === undefined &&
        text(node.arguments[0]) === "`/:id/${operation}`"
      )
        routes = ["provision", "stop", "resume"].map(
          (operation) => `/:id/${operation}`,
        );
      if (routes.some((route) => route === undefined))
        throw new Error(
          `Unresolved route in ${file}: ${text(node.arguments[0])}`,
        );
      const handler = text(node).match(
        /controller\.([A-Za-z]+)(?:\.bind|\()/,
      )?.[1];
      const implementation = controllerMethods.get(`${controller}.${handler}`);
      const contract = implementation?.body || text(node);
      const serviceCalls = [
        ...new Set(
          [
            ...contract.matchAll(
              /(?:this\.)?(\w*(?:Service|service|Store|store))\.([A-Za-z][A-Za-z0-9]*)\(/g,
            ),
          ].map((match) => `${match[1]}.${match[2]}`),
        ),
      ];
      for (const match of contract.matchAll(
        /this\.sourceAccess\(\)\.([A-Za-z]+)\(/g,
      ))
        serviceCalls.push(`AgentSourceAccessService.${match[1]}`);
      const contracts = [
        ...contract.matchAll(
          /req\.(body|query|params)(?:\.([A-Za-z][A-Za-z0-9]*))?/g,
        ),
      ].map((match) => (match[2] ? `${match[1]}.${match[2]}` : match[1]));
      for (const route of routes) {
        const full = join(mount, route);
        const machine = file.endsWith("/agents.ts");
        const publicRoute =
          full === "/api/health" ||
          full.startsWith("/api/setup/") ||
          ["/api/user/login", "/api/user/verify-otp"].includes(full);
        const auth = machine
          ? route === "/enroll"
            ? "one-time enrollment + transport policy"
            : "Agent HMAC, timestamp, nonce + TLS policy"
          : publicRoute
            ? "public; setup/login state checks"
            : "administrator cookie JWT";
        const mode =
          /delete|prune|repair|unlock/.test(full) || method === "DELETE"
            ? "destructive/privileged"
            : ["GET", "HEAD"].includes(method)
              ? "read (may perform IO)"
              : "mutating/privileged";
        const references = tests
          .filter(
            (test) =>
              (test.body.includes(`${controller}`) && controller) ||
              test.body.includes(`routes/${path.basename(file, ".ts")}`),
          )
          .map((test) => test.file);
        const pagination = /\/plans\/:id\/backups$/.test(full)
          ? "page/pageSize, dates, timezone; bounded"
          : /source-access\/requests$/.test(full) && method === "GET"
            ? "bounded keyset cursor"
            : /notifications\/deliveries$/.test(full)
              ? "50 rows; page 0–400"
              : /legacy.*snapshots$/.test(full)
                ? "bounded adapter result; inspect service cursor"
                : /recovery-testing.*tests$/.test(full) && method === "GET"
                  ? "bounded recent 200, not general paging"
                  : "no common pagination contract; see implementation";
        const available = machine
          ? "Agent protocol only; not general API"
          : publicRoute
            ? "public contract (state restrictions)"
            : legacyAllowed.has(`${method} ${full}`)
              ? "legacy key intended; mounted-path defect; use scoped v1 for reads"
              : "session-only; unavailable with legacy key";
        entries.push({
          feature: path.basename(file, ".ts"),
          method,
          route: full,
          handler: handler
            ? `${controller}.${handler}`
            : "inline route handler",
          services: serviceCalls,
          authentication: auth,
          authorization: machine
            ? "Agent identity/command binding"
            : publicRoute
              ? "rate limits and setup/auth state"
              : "single local administrator; no tenant RBAC",
          classification: mode,
          support:
            publicRoute || machine
              ? "Fully supported (special-purpose)"
              : legacyAllowed.has(`${method} ${full}`)
                ? "Partially exposed"
                : "Supported but internal-only",
          request: [...new Set(contracts)],
          requestSchemas: schemaHints(contract),
          response: /download|\/files$/.test(full)
            ? "controller JSON or binary/stream contract; unversioned"
            : "handwritten controller JSON; no common versioned output schema",
          pagination,
          errors:
            [
              ...new Set(
                [...contract.matchAll(/(?:status\(|AppError\()\s*(\d{3})/g)]
                  .map((match) => match[1])
                  .filter((status) => Number(status) >= 400),
              ),
            ].join(", ") || "delegated; inspect controller/service",
          available,
          testReferences: references,
          source: implementation?.file || file,
          routeSource: file,
          security: machine
            ? "Never reuse device/enrollment credentials for MCP."
            : /browse|logs|download|files|settings|storages/.test(full)
              ? "Sensitive paths/configuration/contents; retain administrator boundary; no MCP proxy."
              : mode.startsWith("read")
                ? "Existing DTOs may contain operational details; use explicit v1 projection."
                : "Existing admission rules apply. No external write tools or approval bypass.",
        });
      }
    });
  }
  const operations = source("backend/src/mcp/OperationalReadService.ts");
  walk(operations, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const properties = Object.fromEntries(
      node.properties
        .filter(ts.isPropertyAssignment)
        .map((property) => [
          text(property.name),
          literal(property.initializer),
        ]),
    );
    if (!properties.name?.startsWith("pluton_")) return;
    entries.push({
      feature: "scoped operations",
      method: "GET",
      route: `/api/v1/operations${properties.route}`,
      handler: properties.name,
      services: ["OperationalReadService.read"],
      authentication:
        "native MCP bearer token or external OAuth resource-bound RFC 9068 JWT",
      authorization: `${properties.scope} intersection or native exact tool grant + exact resource IDs + tool policy`,
      classification: "read-only stored evidence",
      support: "Fully supported (read MVP)",
      request: [
        "explicit path IDs",
        "limit 1–50, offset 0–10000 for collections",
      ],
      requestSchemas: [`toolCatalog.${properties.name}.input`],
      response:
        "schemaVersion 1, observedAt, evidence, data; runtime-validated explicit output schema",
      pagination: "collections: limit/offset/hasMore; SQL-bounded",
      errors: "400,401,403,404,429,500; stable code + traceId",
      available:
        "external authenticated clients; service policy must be enabled",
      testReferences: ["backend/__tests__/mcp/gateway.integration.ts"],
      source: "backend/src/mcp/OperationalReadService.ts",
      routeSource: "backend/src/mcp/gateway.ts",
      security:
        "No credentials, names, paths or raw error text. Same projection and audit as MCP.",
    });
  });
  const v2Admin = source("backend/src/mcp/v2AdminRouter.ts");
  walk(v2Admin, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !/^router\.(get|post|put)$/.test(text(node.expression))
    )
      return;
    entries.push({
      feature: "MCP native administration",
      method: text(node.expression).split(".")[1].toUpperCase(),
      route: `/api/mcp-admin${literal(node.arguments[0])}`,
      handler: "strict native token / approval administrator action",
      services: [
        "NativeTokenStore",
        "McpActionService",
        "existing domain services",
      ],
      authentication: "browser administrator cookie JWT only",
      authorization:
        "parent administrator + same-origin JSON guard; approval hash and live token/resource recheck",
      classification: text(node.expression).endsWith("get")
        ? "privileged read"
        : "privileged mutation",
      support: "Supported internal administrator API",
      request: ["strict bounded zod body/query and exact path ID"],
      requestSchemas: ["tokenInput / pageInput / v2AdminRouter inline schema"],
      response:
        "schemaVersion 1, success, result; sanitized error and trace ID; token plaintext only on creation/rotation",
      pagination: "tokens/actions/resources: limit 1-50, offset 0-10000",
      errors: "400,401,403,404,409,429,500",
      available: "authenticated human administrator only",
      testReferences: [
        "backend/__tests__/mcp/native.integration.ts",
        "frontend/__tests__/mcp.test.ts",
      ],
      source: "backend/src/mcp/v2AdminRouter.ts",
      routeSource: "backend/src/mcp/v2AdminRouter.ts",
      security:
        "At-most-once approval dispatch; no machine self-approval; copy-once token verifier; no arbitrary commands or paths",
    });
  });
  const gateway = source("backend/src/mcp/gateway.ts");
  const adminFunction = gateway.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "createMcpAdminRouter",
  );
  walk(adminFunction, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !/^router\.(get|post|put)$/.test(text(node.expression))
    )
      return;
    entries.push({
      feature: "MCP administration",
      method: text(node.expression).split(".")[1].toUpperCase(),
      route: `/api/mcp-admin${literal(node.arguments[0])}`,
      handler: "explicit administration action",
      services: ["McpStore"],
      authentication: "administrator cookie JWT; machine tokens refused",
      authorization: "single administrator; same-origin JSON on writes",
      classification: text(node.expression).endsWith("get")
        ? "privileged read"
        : "privileged mutation",
      support: "Supported but internal-only",
      request: ["strict policy/grant/page schema; path ID"],
      requestSchemas: ["grantInput / pageInput / inline zod schema"],
      response: "schemaVersion 1, success, result; failure: error, traceId",
      pagination: "clients/activity: limit 1–50, offset 0–10000; SQL-bounded",
      errors: "400,401,403,404,409,500; stable codes",
      available: "administrator web session only",
      testReferences: [
        "backend/__tests__/mcp/gateway.integration.ts",
        "frontend/__tests__/mcp.test.ts",
      ],
      source: "backend/src/mcp/gateway.ts",
      routeSource: "backend/src/mcp/gateway.ts",
      security:
        "Durable atomic audit on grants/revocation/policy. Never issues or accepts a model-provider key.",
    });
  });
  for (const [method, route, description] of [
    [
      "POST",
      "/mcp",
      "official SDK Streamable HTTP; initialize/tools/list/tools/call/ping/notifications",
    ],
    [
      "GET",
      "/mcp",
      "HTML browser dashboard; authenticated machine GET returns 405; no standalone SSE stream",
    ],
    ["DELETE", "/mcp", "authenticated 405; no server session"],
    [
      "OPTIONS",
      "/mcp",
      "validated HTTPS Host/Origin preflight; no operational data",
    ],
    [
      "GET",
      "/.well-known/oauth-protected-resource/mcp",
      "RFC 9728 metadata; public only when enabled",
    ],
  ])
    entries.push({
      feature: "MCP protocol",
      method,
      route,
      handler: description,
      services: ["official SDK", "OperationalReadService", "McpStore"],
      authentication:
        method === "OPTIONS" || route.includes("well-known")
          ? "public transport/discovery only when enabled"
          : "native MCP bearer token or resource-bound OAuth JWT; HTML dashboard uses normal web boundary",
      authorization:
        "per-tool scope intersection and exact local resource grant",
      classification:
        "protocol; scoped reads and human-approved operational writes",
      support: "Fully supported within documented protocol versions",
      request: ["official SDK schemas; 16 KiB JSON; exact Host/Origin; TLS"],
      requestSchemas: ["SDK types + toolCatalog"],
      response: "SDK JSON-RPC; tools: schemaVersion 1 evidence DTO",
      pagination: "tools bounded catalog; collections limit/offset",
      errors:
        "transport HTTP codes; SDK JSON-RPC; generic sanitized tool admission errors",
      available: "external MCP clients; disabled by default",
      testReferences: ["backend/__tests__/mcp/gateway.integration.ts"],
      source: "backend/src/mcp/gateway.ts",
      routeSource: "backend/src/mcp/gateway.ts",
      security:
        "No arbitrary API proxy, filesystem, SQL, shell or backup export. Native operational writes create bounded pending approval only.",
    });
  return entries.sort(
    (a, b) =>
      a.route.localeCompare(b.route) || a.method.localeCompare(b.method),
  );
}
export function render(entries) {
  const cell = (value) =>
    String(
      Array.isArray(value) ? value.join("; ") || "none declared here" : value,
    )
      .replaceAll("|", "\\|")
      .replaceAll(/\r?\n/g, " ");
  return (
    `# REST API coverage matrix\n\nGenerated from route/controller ASTs by \`node scripts/api-inventory.mjs\`. Baseline: latest fetched main \`5126fb7\`, plus this branch. No application startup or production data reads are used.\n\n${entries.length} concrete HTTP method/path contracts. Explicit dynamic lifecycle routes and shared read-catalog routes are expanded. This is an inventory, not a claim that legacy contracts are uniformly secure or fully typed. See [audit findings](API_SECURITY_AUDIT.md), [MCP runbook](MCP.md), and the machine-readable [inventory](api-inventory.json).\n\nEach row names the real implementation. Legacy request/response schemas are frequently handwritten or delegated; source links are the authoritative schema evidence. “Test references” identifies relevant test modules by imports, not verified per-endpoint assertion coverage. Missing runtime response validation and uniform pagination are recorded as gaps rather than fabricated schemas.\n\n| Feature / class | Method / route | Handler / service | Authentication / authorization | Request contract | Response contract | Pagination | Errors | External availability / support | Test references | Security implications / evidence |\n|---|---|---|---|---|---|---|---|---|---|---|\n` +
    entries
      .map(
        (entry) =>
          `| ${cell(entry.feature)} / ${cell(entry.classification)} | ${entry.method} \`${cell(entry.route)}\` | ${cell(entry.handler)}; ${cell(entry.services)} | ${cell(entry.authentication)}; ${cell(entry.authorization)} | ${cell(entry.request)}; ${cell(entry.requestSchemas)} | ${cell(entry.response)} | ${cell(entry.pagination)} | ${cell(entry.errors)} | ${cell(entry.available)}; ${cell(entry.support)} | ${cell(entry.testReferences)} | ${cell(entry.security)} [source](../${entry.source}) / [route](../${entry.routeSource}) |`,
      )
      .join("\n") +
    "\n"
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const entries = inventory();
  const outputs = [
    ["docs/api-inventory.json", JSON.stringify(entries, null, 2) + "\n"],
    ["docs/API_COVERAGE_MATRIX.md", render(entries)],
  ];
  for (const [file, content] of outputs) {
    if (process.argv.includes("--check")) {
      if (read(file) !== content) throw new Error(`Stale inventory: ${file}`);
    } else fs.writeFileSync(path.join(root, file), content);
  }
  console.log(`Verified ${entries.length} HTTP contracts.`);
}
