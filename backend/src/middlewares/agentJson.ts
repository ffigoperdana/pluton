import express, { type RequestHandler } from 'express';
import type { AgentRequest } from '../types/agents';

/**
 * A bounded Source Access completion can repeat 32 maximum-length UTF-8 paths
 * in its report and validation. Keep its transport budget on Agent routes only.
 * Raw input is retained before JSON parsing so existing HMAC signatures cover
 * the exact request body, including whitespace and Unicode.
 */
export const agentJson: RequestHandler = express.json({
	limit: '512kb',
	verify: (req, _res, buffer) => {
		(req as AgentRequest).rawBody = buffer.toString('utf8');
	},
});
