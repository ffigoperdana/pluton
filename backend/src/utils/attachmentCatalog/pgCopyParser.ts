/**
 * Streaming reader for one table's data in a PostgreSQL plain-format dump
 * (`pg_dump --format=plain`, the format Managed Agents produce). The dump writes
 * each table as
 *
 *   COPY public.<table> (<col>, <col>, ...) FROM stdin;
 *   <row: text-format fields separated by TAB>
 *   \.
 *
 * Only the requested columns are kept, each bounded, so a row holding a large
 * value in another column (an attachment stored in the database, extracted text)
 * never has to fit in memory. Lines outside the target block are skipped with
 * native newline searches, and a line inside another table's COPY block is never
 * mistaken for a statement. The reader stops at the end of the target block.
 */

const TAB = 0x09;
const NEWLINE = 0x0a;
const BACKSLASH = 0x5c;
const PERIOD = 0x2e;
/** Statements outside COPY data are short; longer lines cannot be a COPY header. */
const MAX_STATEMENT_LINE = 64 * 1024;

export type PgCopyRow = Record<string, string | null>;

export class PgCopyParseError extends Error {
	constructor(readonly reason: 'table-missing' | 'columns-missing' | 'row-malformed' | 'truncated') {
		super(`Database dump could not be read (${reason}).`);
	}
}

export type PgCopyTarget = {
	/** Schema-qualified and bare names that identify the table, e.g. public.ir_attachment. */
	tables: string[];
	/** Columns to keep. Columns the dump does not have are absent from each row. */
	columns: string[];
	required: string[];
	/** Largest raw value kept for one field, in bytes; longer values are truncated. */
	maxFieldBytes: number;
};

/** Decodes a COPY text-format field. Returns null for the NULL marker. */
export function decodeCopyText(raw: Buffer): string | null {
	if (raw.length === 2 && raw[0] === BACKSLASH && raw[1] === 0x4e) return null;
	if (!raw.includes(BACKSLASH)) return raw.toString('utf8');
	const out: number[] = [];
	const hex = (byte: number) =>
		(byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
	for (let i = 0; i < raw.length; i++) {
		const byte = raw[i];
		if (byte !== BACKSLASH || i + 1 >= raw.length) {
			out.push(byte);
			continue;
		}
		const next = raw[++i];
		if (next === 0x62) out.push(0x08); // \b
		else if (next === 0x66) out.push(0x0c); // \f
		else if (next === 0x6e) out.push(0x0a); // \n
		else if (next === 0x72) out.push(0x0d); // \r
		else if (next === 0x74) out.push(0x09); // \t
		else if (next === 0x76) out.push(0x0b); // \v
		else if (next === 0x78 && i + 1 < raw.length && hex(raw[i + 1])) {
			// \xH or \xHH
			let value = parseInt(String.fromCharCode(raw[++i]), 16);
			if (i + 1 < raw.length && hex(raw[i + 1]))
				value = value * 16 + parseInt(String.fromCharCode(raw[++i]), 16);
			out.push(value);
		} else if (next >= 0x30 && next <= 0x37) {
			// \o, \oo or \ooo
			let value = next - 0x30;
			for (let digits = 1; digits < 3 && i + 1 < raw.length && raw[i + 1] >= 0x30 && raw[i + 1] <= 0x37; digits++)
				value = value * 8 + (raw[++i] - 0x30);
			out.push(value & 0xff);
		} else out.push(next); // \\ and any other escaped byte stand for themselves
	}
	return Buffer.from(out).toString('utf8');
}

/** Parses `COPY <name> (<columns>) FROM stdin;` into the table name and column list. */
export function parseCopyHeader(line: string): { table: string; columns: string[] } | undefined {
	const match = /^COPY\s+(\S+)\s+\((.*)\)\s+FROM\s+stdin;$/.exec(line);
	if (!match) return undefined;
	const unquote = (value: string) => {
		const trimmed = value.trim();
		return trimmed.startsWith('"') && trimmed.endsWith('"')
			? trimmed.slice(1, -1).replace(/""/g, '"')
			: trimmed;
	};
	return { table: match[1].split('.').map(unquote).join('.'), columns: match[2].split(',').map(unquote) };
}

type State = 'statements' | 'other-copy' | 'rows' | 'done';

export class PgCopyTableReader {
	private state: State = 'statements';
	/** Current line outside the target block (bounded) and its full length. */
	private line: Buffer[] = [];
	private lineKept = 0;
	private lineLength = 0;
	/** Row state inside the target block. */
	private keep: (number | undefined)[] = [];
	private column = 0;
	private rowLength = 0;
	private field: Buffer[] = [];
	private fieldKept = 0;
	private fields: (Buffer | undefined)[] = [];
	private headerColumns: string[] = [];

	constructor(
		private readonly target: PgCopyTarget,
		private readonly onRow: (row: PgCopyRow) => void
	) {}

	get done() {
		return this.state === 'done';
	}

	/** The columns of the target table as the dump declared them, once found. */
	get columns() {
		return this.headerColumns;
	}

	write(chunk: Buffer) {
		let i = 0;
		while (i < chunk.length && this.state !== 'done')
			i = this.state === 'rows' ? this.rowBytes(chunk, i) : this.lineBytes(chunk, i);
	}

	/** Call when the dump ended; an unfinished target block is a truncated dump. */
	end() {
		if (this.state === 'rows') throw new PgCopyParseError('truncated');
		if (this.state !== 'done') throw new PgCopyParseError('table-missing');
	}

	private lineBytes(chunk: Buffer, start: number): number {
		const newline = chunk.indexOf(NEWLINE, start);
		const stop = newline < 0 ? chunk.length : newline;
		const length = stop - start;
		// Another table's data is only checked for the end marker, never kept.
		const room = this.state === 'other-copy' ? Math.max(0, 2 - this.lineKept) : MAX_STATEMENT_LINE - this.lineKept;
		if (room > 0 && length > 0) {
			const piece = chunk.subarray(start, start + Math.min(room, length));
			this.line.push(piece);
			this.lineKept += piece.length;
		}
		this.lineLength += length;
		if (newline < 0) return chunk.length;
		this.finishLine();
		return newline + 1;
	}

	private finishLine() {
		const head = Buffer.concat(this.line);
		const length = this.lineLength;
		this.line = [];
		this.lineKept = 0;
		this.lineLength = 0;
		if (this.state === 'other-copy') {
			if (length === 2 && head[0] === BACKSLASH && head[1] === PERIOD) this.state = 'statements';
			return;
		}
		if (length > MAX_STATEMENT_LINE || head.length < 5 || head.toString('latin1', 0, 5) !== 'COPY ') return;
		const header = parseCopyHeader(head.toString('utf8'));
		if (!header) return;
		if (!this.target.tables.includes(header.table)) {
			this.state = 'other-copy';
			return;
		}
		if (this.target.required.some(name => !header.columns.includes(name)))
			throw new PgCopyParseError('columns-missing');
		this.headerColumns = header.columns;
		this.keep = header.columns.map(name => {
			const wanted = this.target.columns.indexOf(name);
			return wanted >= 0 ? wanted : undefined;
		});
		this.state = 'rows';
		this.resetRow();
	}

	private resetRow() {
		this.column = 0;
		this.rowLength = 0;
		this.field = [];
		this.fieldKept = 0;
		this.fields = new Array(this.target.columns.length).fill(undefined);
	}

	/** Column 0 is always kept (bounded) to recognise the `\.` end marker. */
	private fieldLimit() {
		return this.keep[this.column] !== undefined
			? this.target.maxFieldBytes
			: this.column === 0
				? 2
				: 0;
	}

	private rowBytes(chunk: Buffer, start: number): number {
		const tab = chunk.indexOf(TAB, start);
		const newline = chunk.indexOf(NEWLINE, start);
		const stop =
			tab < 0 ? (newline < 0 ? chunk.length : newline) : newline < 0 ? tab : Math.min(tab, newline);
		const length = stop - start;
		const room = this.fieldLimit() - this.fieldKept;
		if (room > 0 && length > 0) {
			const piece = chunk.subarray(start, start + Math.min(room, length));
			this.field.push(Buffer.from(piece));
			this.fieldKept += piece.length;
		}
		this.rowLength += length;
		if (stop === chunk.length) return chunk.length;
		const raw = Buffer.concat(this.field);
		if (chunk[stop] === NEWLINE && this.column === 0 && this.rowLength === 2 && raw[0] === BACKSLASH && raw[1] === PERIOD) {
			this.state = 'done';
			return stop + 1;
		}
		const slot = this.keep[this.column];
		if (slot !== undefined) this.fields[slot] = raw;
		this.field = [];
		this.fieldKept = 0;
		this.column++;
		this.rowLength++;
		if (chunk[stop] === TAB) {
			if (this.column >= this.keep.length) throw new PgCopyParseError('row-malformed');
			return stop + 1;
		}
		if (this.column !== this.keep.length) throw new PgCopyParseError('row-malformed');
		const row: PgCopyRow = {};
		this.target.columns.forEach((name, index) => {
			const value = this.fields[index];
			if (value !== undefined) row[name] = decodeCopyText(value);
		});
		this.onRow(row);
		this.resetRow();
		return stop + 1;
	}
}
