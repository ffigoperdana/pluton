import type { Request, Response } from 'express';
import { AppError } from '../utils/AppError';
import { AgentService } from '../services/AgentService';
import type { AgentSourceAccessService } from '../services/AgentSourceAccessService';

export class AgentAdminController {
	constructor(private readonly agentService: AgentService, private readonly sourceAccessService?: AgentSourceAccessService) {}

	private sourceAccess(): AgentSourceAccessService {
		if (!this.sourceAccessService) throw new AppError(503, 'Source Access service is unavailable.');
		return this.sourceAccessService;
	}

	async getSourceAccess(req: Request, res: Response): Promise<void> {
		res.setHeader('Cache-Control', 'no-store');
		try { res.json({ success: true, result: await this.sourceAccess().getView(req.params.id) }); }
		catch (error) { this.respond(res, error); }
	}

	async validateSourceAccess(req: Request, res: Response): Promise<void> {
		try { res.status(202).json({ success: true, result: await this.sourceAccess().request(req.params.id, 'validate', req.body) }); }
		catch (error) { this.respond(res, error); }
	}

	async requestSourceAccess(req: Request, res: Response): Promise<void> {
		try { res.status(202).json({ success: true, result: await this.sourceAccess().request(req.params.id, 'apply', req.body) }); }
		catch (error) { this.respond(res, error); }
	}

	async refreshSourceAccess(req: Request, res: Response): Promise<void> {
		try { res.status(202).json({ success: true, result: await this.sourceAccess().refresh(req.params.id) }); }
		catch (error) { this.respond(res, error); }
	}

	async setupSourceAccessMode(req: Request, res: Response): Promise<void> {
		try { res.status(202).json({ success: true, result: await this.sourceAccess().setupMode(req.params.id, req.body) }); }
		catch (error) { this.respond(res, error); }
	}

	async cancelSourceAccess(req: Request, res: Response): Promise<void> {
		try { await this.sourceAccess().cancel(req.params.id, req.params.requestId); res.json({ success: true }); }
		catch (error) { this.respond(res, error); }
	}

	async createEnrollment(req: Request, res: Response): Promise<void> {
		try {
			const result = await this.agentService.createEnrollment(req.body);
			res.status(201).json({ success: true, result });
		} catch (error) {
			this.respond(res, error);
		}
	}

	async revokeEnrollment(req: Request, res: Response): Promise<void> {
		try {
			await this.agentService.revokeEnrollment(req.params.id);
			res.json({ success: true });
		} catch (error) {
			this.respond(res, error);
		}
	}

	async revokeDevice(req: Request, res: Response): Promise<void> {
		try {
			await this.agentService.revokeDevice(req.params.id);
			res.json({ success: true });
		} catch (error) {
			this.respond(res, error);
		}
	}

	private respond(res: Response, error: unknown): void {
		const status = error instanceof AppError ? error.statusCode : 500;
		const message = error instanceof AppError ? error.message : 'Agent request failed.';
		res.status(status).json({ success: false, error: message });
	}
}
