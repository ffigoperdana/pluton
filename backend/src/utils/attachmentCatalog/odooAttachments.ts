import type { PgCopyRow, PgCopyTarget } from './pgCopyParser';

/**
 * Odoo keeps every binary attachment in its filestore under a content hash
 * (`<filestore>/<db>/<2 hex>/<40 hex>`, stored as `store_fname`) and records the
 * original name, type and owning record in `ir_attachment`. Odoo 12 and older
 * kept the file name in `datas_fname` and a free-form label in `name`; newer
 * versions only have `name`.
 */
export const ODOO_ATTACHMENT_TARGET: PgCopyTarget = {
	tables: ['public.ir_attachment', 'ir_attachment'],
	columns: [
		'id',
		'name',
		'datas_fname',
		'store_fname',
		'type',
		'res_model',
		'res_id',
		'res_field',
		'file_size',
		'mimetype',
		'create_date',
	],
	required: ['id', 'name', 'store_fname'],
	maxFieldBytes: 4096,
};

export type CatalogAttachment = {
	id: number;
	name: string;
	storedPath: string;
	mimetype: string | null;
	size: number | null;
	model: string | null;
	recordId: number | null;
	field: string | null;
	created: string | null;
};

export type OdooRowOutcome =
	| { kind: 'attachment'; value: CatalogAttachment }
	/** Stored in the database or a URL: not part of the filestore. */
	| { kind: 'not-in-filestore' }
	| { kind: 'invalid' };

/** A filestore-relative path as Odoo writes it; never absolute and never escaping. */
const STORED_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}){0,7}$/;

/** Replaces C0 control characters and DEL. */
const withoutControls = (value: string, replacement: string) =>
	Array.from(value, character => {
		const code = character.charCodeAt(0);
		return code <= 0x1f || code === 0x7f ? replacement : character;
	}).join('');

const text = (value: string | null | undefined, max: number) => {
	if (value === null || value === undefined) return null;
	// Control characters never reach the catalog; the name is shown and used as a file name.
	const clean = withoutControls(value, ' ').trim();
	return clean ? clean.slice(0, max) : null;
};
const integer = (value: string | null | undefined) => {
	if (!value || !/^-?\d{1,15}$/.test(value)) return null;
	return Number(value);
};

export function odooAttachmentFromRow(row: PgCopyRow): OdooRowOutcome {
	const id = integer(row.id);
	if (id === null) return { kind: 'invalid' };
	const stored = row.store_fname;
	if (!stored || row.type === 'url') return { kind: 'not-in-filestore' };
	if (!STORED_PATH.test(stored) || stored.split('/').some(part => part === '..' || part === '.'))
		return { kind: 'invalid' };
	const size = integer(row.file_size);
	return {
		kind: 'attachment',
		value: {
			id,
			name: text(row.datas_fname, 255) || text(row.name, 255) || stored.split('/').pop()!,
			storedPath: stored,
			mimetype: text(row.mimetype, 128),
			size: size !== null && size >= 0 ? size : null,
			model: text(row.res_model, 128),
			recordId: integer(row.res_id),
			field: text(row.res_field, 128),
			created: text(row.create_date, 40),
		},
	};
}

/**
 * The file name sent with a download: the original name without path separators
 * or control characters, and an ASCII fallback for clients that ignore RFC 5987.
 */
export function attachmentDownloadNames(name: string): { ascii: string; utf8: string } {
	const base =
		withoutControls(name.replace(/[\\/"]/g, '_'), '_')
			.trim()
			.slice(0, 200) || 'attachment';
	const ascii = base.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '_') || 'attachment';
	return { ascii, utf8: base };
}
