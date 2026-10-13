import type { Express } from 'express';
import path from 'path';
/** Public static SPA entry only; registered API handlers remain ahead of this fallback. */
export function registerSpaFallback(app: Express, publicPath: string) {
	app.get('{*path}', (_req, res) => res.sendFile(path.join(publicPath, 'index.html')));
}
