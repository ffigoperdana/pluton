import type { Express } from 'express';
import path from 'path';
/** Public static SPA entry only; registered API handlers remain ahead of this fallback. */
export function registerSpaFallback(app: Express, publicPath: string) {
	app.get(['/docs', '/docs/{*path}'], (req, res) => {
		// Real docs assets are served by express.static first. Never return HTML for
		// a missing module/index/license, or interpret a request path as a file path.
		if (
			req.path.startsWith('/docs/assets/') ||
			req.path.startsWith('/docs/licenses/') ||
			path.posix.basename(req.path).includes('.')
		) {
			res.sendStatus(404);
			return;
		}
		res.sendFile(path.join(publicPath, 'docs', 'index.html'));
	});
	app.get('{*path}', (_req, res) => res.sendFile(path.join(publicPath, 'index.html')));
}
