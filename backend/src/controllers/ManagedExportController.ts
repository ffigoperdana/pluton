import crypto from 'crypto';
import type { Request, Response } from 'express';
import Cookies from 'cookies';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { configService } from '../services/ConfigService';
import { ManagedExportService } from '../services/ManagedExportService';
import {
	TemporaryExportError,
	exportConfigurationStatus,
} from '../utils/managedExport/ExportPolicy';
import { AppError } from '../utils/AppError';
import { observeTransfer, transferReason } from '../utils/managedExport/TransferTelemetry';

/** Session owner is verified independently; browser inputs cannot choose it. */
export function exportOwner(req: Request, res: Response): string {
	const token = new Cookies(req, res).get('token');
	if (!token) throw new AppError(401, 'Authentication required.');
	try {
		const payload = jwt.verify(token, configService.config.SECRET!) as jwt.JwtPayload;
		if (typeof payload.user !== 'string' || !payload.user || payload.user.length > 256)
			throw new Error();
		return crypto.createHash('sha256').update(payload.user).digest('hex');
	} catch {
		throw new AppError(401, 'Authentication required.');
	}
}
export class ManagedExportController {
	constructor(private readonly exports?: ManagedExportService) {}
	private get service() {
		if (!this.exports) throw new TemporaryExportError('not-configured');
		return this.exports;
	}
	private request(req: Request, res: Response) {
		if (Object.keys(req.query).length)
			throw new AppError(400, 'Export accepts no query overrides.');
		return { owner: exportOwner(req, res), backup: req.params.id, id: req.params.exportId };
	}
	private operator(req: Request, res: Response) {
		if (Object.keys(req.query).length || Object.keys(req.body || {}).length)
			throw new AppError(400, 'Preflight accepts no configuration overrides.');
		res.setHeader('Cache-Control', 'private, no-store');
		return exportOwner(req, res);
	}
	async configuration(req: Request, res: Response) {
		try {
			this.operator(req, res);
			res.json({ success: true, result: exportConfigurationStatus() });
		} catch (error) {
			this.failure(error, res);
		}
	}
	async preflight(req: Request, res: Response) {
		try {
			const owner = this.operator(req, res);
			res.status(202).json({ success: true, result: await this.service.preflight(owner) });
		} catch (error) {
			this.failure(error, res);
		}
	}
	async preflightStatus(req: Request, res: Response) {
		try {
			const owner = this.operator(req, res);
			res.json({
				success: true,
				result: await this.service.preflightStatus(owner, req.params.preflightId),
			});
		} catch (error) {
			this.failure(error, res);
		}
	}
	async cancelPreflight(req: Request, res: Response) {
		try {
			const owner = this.operator(req, res);
			res.json({
				success: true,
				result: await this.service.cancelPreflight(owner, req.params.preflightId),
			});
		} catch (error) {
			this.failure(error, res);
		}
	}
	private failure(error: unknown, res: Response) {
		if (res.headersSent || res.destroyed) {
			if (!res.destroyed) res.destroy();
			return;
		}
		res.removeHeader('Content-Disposition');
		res.removeHeader('Content-Length');
		res.removeHeader('Content-Type');
		res.status(error instanceof AppError ? error.statusCode : 502).json({
			success: false,
			error: error instanceof AppError ? error.message : 'Reliable Download unavailable.',
			...(error instanceof TemporaryExportError ? { code: error.code, reason: error.reason } : {}),
		});
	}
	async create(req: Request, res: Response) {
		try {
			const { owner, backup } = this.request(req, res);
			const body = z
				.strictObject({ mode: z.enum(['full', 'regular-files']).default('full') })
				.safeParse(req.body || {});
			if (!body.success) throw new AppError(400, 'Invalid export request.');
			const result = await this.service.admit(owner, backup, body.data.mode);
			res.setHeader('Cache-Control', 'private, no-store');
			res.status(202).json({ success: true, result });
		} catch (error) {
			this.failure(error, res);
		}
	}
	async status(req: Request, res: Response) {
		try {
			const { owner, backup, id } = this.request(req, res);
			res.setHeader('Cache-Control', 'private, no-store');
			res.json({ success: true, result: await this.service.status(owner, backup, id) });
		} catch (error) {
			this.failure(error, res);
		}
	}
	async cancel(req: Request, res: Response) {
		try {
			if (Object.keys(req.body || {}).length) throw new AppError(400, 'Invalid cancellation.');
			const { owner, backup, id } = this.request(req, res);
			res.setHeader('Cache-Control', 'private, no-store');
			res.json({ success: true, result: await this.service.cancel(owner, backup, id) });
		} catch (error) {
			this.failure(error, res);
		}
	}
	async authorization(req: Request, res: Response) {
		try {
			if (Object.keys(req.body || {}).length)
				throw new AppError(400, 'Invalid authorization request.');
			const { owner, backup, id } = this.request(req, res);
			res.setHeader('Cache-Control', 'private, no-store');
			res.setHeader('Referrer-Policy', 'no-referrer');
			const result = await this.service.authorize(owner, backup, id);
			if (req.method === 'GET') {
				res.redirect(303, result.url);
				return;
			}
			res.json({ success: true, result });
		} catch (error) {
			this.failure(error, res);
		}
	}
	async content(req: Request, res: Response) {
		const stop = new AbortController(),
			transfer = observeTransfer(res, 'reliable-proxy');
		const close = () => {
			if (!res.writableFinished) stop.abort();
		};
		req.once('aborted', close);
		res.once('close', close);
		try {
			const { owner, backup, id } = this.request(req, res);
			await this.service.content(
				owner,
				backup,
				id,
				req.headers.range,
				req.headers['if-range'],
				req.method === 'HEAD',
				transfer.output,
				stop.signal,
				value => {
					res.status(value.status);
					res.setHeader('Content-Type', 'application/x-tar');
					res.setHeader('Content-Disposition', `attachment; filename="${value.fileName}"`);
					res.setHeader('Cache-Control', 'private, no-store');
					res.setHeader('Accept-Ranges', 'bytes');
					res.setHeader('ETag', value.etag);
					res.setHeader('X-Archive-SHA256', value.sha256);
					res.setHeader('Content-Length', value.length);
					if (value.status === 206)
						res.setHeader('Content-Range', `bytes ${value.start}-${value.end}/${value.size}`);
				}
			);
			if (!res.destroyed) res.end();
			transfer.finish('origin-stream-complete');
		} catch (error) {
			if (!res.headersSent) res.statusCode = error instanceof AppError ? error.statusCode : 502;
			transfer.finish(stop.signal.aborted ? 'peer-closed' : transferReason(error));
			if (
				error instanceof TemporaryExportError &&
				error.reason === 'range-invalid' &&
				!res.headersSent
			) {
				const s = await this.service
					.status(exportOwner(req, res), req.params.id, req.params.exportId)
					.catch(() => undefined);
				if (s?.totalBytes) res.setHeader('Content-Range', `bytes */${s.totalBytes}`);
			}
			this.failure(error, res);
		} finally {
			req.removeListener('aborted', close);
			res.removeListener('close', close);
		}
	}
}
