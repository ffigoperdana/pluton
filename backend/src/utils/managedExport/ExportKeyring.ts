import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { AppError } from '../AppError';

export class ExportKeyError extends AppError {
	readonly code = 'temporary-export-refused';
	readonly reason = 'encryption-key-unavailable';
	constructor() {
		super(409, 'Reliable Download unavailable (encryption-key-unavailable).');
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
export const keyringSchema = z.strictObject({
	version: z.literal(1),
	active: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	keys: z.record(
		z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
		z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
	),
});
/** Dedicated host secret, never an application/database/S3 credential. No cache:
 * a redeployed read-only mount can select a new active key while retaining old slots. */
export class ExportKeyring {
	private readonly keys = new Map<string, Buffer>();
	readonly active: string;
	constructor(file?: string) {
		let fd: number | undefined;
		try {
			if (!file || !path.isAbsolute(file) || fs.realpathSync(file) !== path.resolve(file))
				throw new Error();
			fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
			const stat = fs.fstatSync(fd);
			if (
				!stat.isFile() ||
				stat.nlink !== 1 ||
				stat.size > 16 * 1024 ||
				(process.platform !== 'win32' &&
					(stat.mode & 0o037 ||
						![0, process.getuid!()].includes(stat.uid) ||
						(stat.mode & 0o040 && stat.gid !== process.getgid!())))
			)
				throw new Error();
			const data = fs.readFileSync(fd);
			try {
				const value = keyringSchema.parse(JSON.parse(data.toString('utf8')));
				if (Object.keys(value.keys).length > 16 || !value.keys[value.active]) throw new Error();
				for (const [id, encoded] of Object.entries(value.keys)) {
					const key = Buffer.from(encoded, 'base64');
					if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error();
					this.keys.set(id, key);
				}
				this.active = value.active;
			} finally {
				data.fill(0);
			}
		} catch {
			this.close();
			throw new ExportKeyError();
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
	}
	key(id = this.active) {
		const key = this.keys.get(id);
		if (!key) throw new ExportKeyError();
		return key;
	}
	/** Private capability binding only; never exposed by configuration status. */
	fingerprint() {
		return crypto.createHash('sha256').update(this.active).update(this.key()).digest('hex');
	}
	close() {
		for (const key of this.keys.values()) key.fill(0);
		this.keys.clear();
	}
}
