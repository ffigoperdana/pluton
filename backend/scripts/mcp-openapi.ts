import fs from 'node:fs';
import { z } from 'zod';
import { toolCatalog, outputSchema } from '../src/mcp/OperationalReadService';
const paths: Record<string, unknown> = {};
for (const tool of toolCatalog) {
	const input = z.toJSONSchema(tool.input, { io: 'input' });
	const route = `/api/v1/operations${tool.route}`.replace(/:([A-Za-z]+)/g, '{$1}');
	const pathNames = [...route.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
	const properties = input.properties || {};
	const parameters = Object.entries(properties).map(([name, schema]) => ({
		name,
		in: pathNames.includes(name) ? 'path' : 'query',
		required: pathNames.includes(name),
		schema,
	}));
	paths[route] = {
		get: {
			'operationId': tool.name,
			'summary': tool.description,
			'security': [{ resourceToken: [] }],
			'x-required-scope': tool.scope,
			'x-resource-policy': 'Exact IDs from local subject/client grant; tool must be enabled',
			parameters,
			'responses': {
				'200': {
					description: 'Stored evidence, not a live repository probe',
					content: { 'application/json': { schema: z.toJSONSchema(outputSchema(tool)) } },
				},
				...Object.fromEntries(
					[400, 401, 403, 404, 429, 500].map(status => [
						String(status),
						{
							description: 'Stable sanitized error code and trace identifier',
							content: {
								'application/json': {
									schema: {
										type: 'object',
										required: ['schemaVersion', 'success', 'error', 'traceId'],
										properties: {
											schemaVersion: { const: '1' },
											success: { const: false },
											error: { type: 'string' },
											traceId: { type: 'string' },
										},
										additionalProperties: false,
									},
								},
							},
						},
					])
				),
			},
		},
	};
}
const document = {
	openapi: '3.1.0',
	info: {
		title: 'Pluton scoped operational reads',
		version: '1.0.0',
		description:
			'Only scoped REST read contracts. Native tokens and external OAuth tokens are separate supported modes. Native operational write tools use MCP with human approvals, not these REST read endpoints. Administration routes are inventoried separately.',
	},
	servers: [{ url: 'https://backup.example.internal' }],
	components: {
		securitySchemes: {
			resourceToken: {
				type: 'http',
				scheme: 'bearer',
				bearerFormat: 'Native Pluton MCP token or RFC 9068 JWT',
				description:
					'Native tokens require MCP_NATIVE_TOKENS_ENABLED=true and exact tool/resource grants. OAuth resource audience must equal MCP_RESOURCE_URL; issuer discovery is available only when OAuth is configured.',
			},
		},
	},
	paths,
};
const output = JSON.stringify(document, null, 2) + '\n';
const destination = new URL('../../docs/mcp-openapi.json', import.meta.url);
if (process.argv.includes('--check')) {
	if (fs.readFileSync(destination, 'utf8') !== output)
		throw new Error('Stale MCP OpenAPI document');
} else fs.writeFileSync(destination, output);
console.log(`Verified ${toolCatalog.length} scoped OpenAPI read contracts.`);
