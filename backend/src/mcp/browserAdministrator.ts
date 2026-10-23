import type { RequestHandler } from 'express';
import Cookies from 'cookies';
import jwt from 'jsonwebtoken';
import { configService } from '../services/ConfigService';
import { parseWebOrigins, requestWebOrigin, sameOriginJson } from '../utils/webOrigins';

/** Current community edition has one local administrator. Never accepts machine/API tokens. */
export const mcpBrowserAdministrator: RequestHandler = (req, res, next) => {
	let decoded: jwt.JwtPayload;
	const policy = parseWebOrigins(configService.config);
	try {
		const token = new Cookies(req, res).get('token');
		const value = jwt.verify(token || '', configService.config.SECRET, { algorithms: ['HS256'] });
		const origin = requestWebOrigin(req, policy);
		if (
			typeof value === 'string' ||
			!origin ||
			(value.webOrigin !== undefined && value.webOrigin !== origin)
		)
			throw new Error();
		decoded = value;
	} catch {
		res
			.status(401)
			.json({
				schemaVersion: '1',
				success: false,
				error: 'administrator_session_required',
				traceId: res.locals.traceId,
			});
		return;
	}
	if (
		typeof decoded.user !== 'string' ||
		![configService.config.USER_NAME, 'admin'].includes(decoded.user) ||
		(!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOriginJson(req, policy))
	) {
		res
			.status(403)
			.json({
				schemaVersion: '1',
				success: false,
				error: 'administrator_required',
				traceId: res.locals.traceId,
			});
		return;
	}
	res.locals.mcpAdministrator = decoded.user;
	next();
};
