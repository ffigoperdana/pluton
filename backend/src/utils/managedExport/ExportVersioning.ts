import { Readable } from 'stream';
import { SaxesParser } from 'saxes';
import type {
	GetBucketVersioningCommand,
	GetBucketVersioningCommandOutput,
} from '@aws-sdk/client-s3';
import { ExportOperationError, exportHttpStatus } from './ExportDiagnostics';
import {
	exportTransportCode,
	publicExportRequest,
	type ExportRequestDiagnostic,
} from './ExportRequestDiagnostics';

const BODY_LIMIT = 16 * 1024;
/** Status absent is valid only in a complete VersioningConfiguration document.
 * The SDK alone maps empty/wrong-root documents to an absent Status as well. */
function validate(body: Buffer) {
	let depth = 0,
		root = false,
		namespace = '',
		field = '',
		value = '';
	const seen = new Set<string>();
	let status: string | undefined;
	const parser = new SaxesParser({ xmlns: true });
	const invalid = () => {
		throw new Error('Invalid versioning XML');
	};
	parser.on('error', invalid);
	parser.on('doctype', invalid);
	parser.on('opentag', tag => {
		depth++;
		if (depth === 1) {
			if (
				root ||
				tag.local !== 'VersioningConfiguration' ||
				![
					'',
					'http://s3.amazonaws.com/doc/2006-03-01/',
					'http://s3.amazonaws.com/doc/2020-09-01/',
				].includes(tag.uri)
			)
				invalid();
			root = true;
			namespace = tag.uri;
		} else if (depth === 2) {
			if (!['Status', 'MfaDelete', 'MFADelete'].includes(tag.local) || tag.uri !== namespace)
				invalid();
			field = tag.local === 'MFADelete' ? 'MfaDelete' : tag.local;
			if (seen.has(field)) invalid();
			seen.add(field);
			value = '';
		} else invalid();
		if (Object.values(tag.attributes).some(a => a.uri !== 'http://www.w3.org/2000/xmlns/'))
			invalid();
	});
	const content = (text: string) => {
		if (depth === 2) value += text;
		else if (text.trim()) invalid();
	};
	parser.on('text', content);
	parser.on('cdata', content);
	parser.on('closetag', () => {
		if (
			depth === 2 &&
			!(field === 'Status' ? ['Enabled', 'Suspended'] : ['Enabled', 'Disabled']).includes(value)
		)
			invalid();
		if (depth === 2 && field === 'Status') status = value;
		depth--;
	});
	parser.write(new TextDecoder('utf-8', { fatal: true }).decode(body)).close();
	if (!root) invalid();
	return status;
}

/** Retains the caller's deadline and cancellation signal. Does not add retries,
 * change signing/query/TLS, or infer success from elapsed time or a status alone. */
export async function checkedVersioning(
	command: GetBucketVersioningCommand,
	signal: AbortSignal,
	send: () => Promise<GetBucketVersioningCommandOutput>
) {
	const start = performance.now();
	const trace: ExportRequestDiagnostic = {
		phase: 'sdk',
		elapsedMs: 0,
		attempts: 0,
		abortedAtStart: signal.aborted,
		abortReason: 'none',
		transportCode: 'none',
		bodyComplete: false,
	};
	const aborted = () =>
		Object.assign(new Error('Versioning request aborted'), {
			name: signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError',
		});
	let parsedStatus: string | undefined;
	// The strict parser and SDK must agree. Never interpret a dropped/namespaced
	// Enabled/Suspended field as disabled merely because the SDK omitted it.
	command.middlewareStack.add(
		next => async args => {
			const result = await next(args);
			if (!result.output || result.output.Status !== parsedStatus)
				throw new ExportOperationError(
					'GetBucketVersioning',
					result.output,
					'versioning-response-invalid',
					'cleanup-pending',
					'namespace'
				);
			return result;
		},
		{ step: 'deserialize', priority: 'high', name: 'exportVersioningSdkResult' }
	);
	command.middlewareStack.add(
		next => async args => {
			trace.phase = 'request';
			trace.attempts++;
			trace.bodyComplete = false;
			trace.httpStatus = undefined;
			trace.headersMs = undefined;
			if (signal.aborted) throw aborted();
			const result = await next(args);
			const response = result.response as {
				statusCode?: number;
				headers?: Record<string, string>;
				body?: unknown;
			};
			trace.httpStatus = exportHttpStatus({ $metadata: { httpStatusCode: response.statusCode } });
			trace.headersMs = Math.round(performance.now() - start);
			trace.phase = 'body';
			const raw = response.body;
			const body =
				raw instanceof Readable
					? raw
					: typeof raw === 'string' || raw instanceof Uint8Array
						? Readable.from([raw])
						: undefined;
			const invalid = () =>
				new ExportOperationError(
					'GetBucketVersioning',
					{ $metadata: { httpStatusCode: trace.httpStatus } },
					'versioning-response-invalid',
					'cleanup-pending',
					'namespace'
				);
			if (!body) throw invalid();
			const abort = () => body.destroy(aborted());
			signal.addEventListener('abort', abort, { once: true });
			let bytes = 0;
			const chunks: Buffer[] = [];
			try {
				if (signal.aborted) abort();
				for await (const chunk of body) {
					bytes += Buffer.byteLength(chunk);
					if (bytes > BODY_LIMIT) throw invalid();
					chunks.push(Buffer.from(chunk));
				}
			} finally {
				signal.removeEventListener('abort', abort);
				body.destroy();
			}
			if (signal.aborted) throw aborted();
			const length = response.headers?.['content-length'];
			if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== bytes))
				throw invalid();
			trace.bodyComplete = true;
			const collected = Buffer.concat(chunks);
			if (trace.httpStatus === 200) {
				trace.phase = 'xml';
				try {
					parsedStatus = validate(collected);
				} catch {
					throw invalid();
				}
			} else if (!trace.httpStatus || trace.httpStatus < 300) throw invalid();
			// Keep SDK deserialization/error semantics, including explicit 501/403.
			response.body = Readable.from([collected]);
			trace.phase = 'deserialize';
			return result;
		},
		{ step: 'deserialize', priority: 'low', name: 'exportVersioningResponse' }
	);
	try {
		if (signal.aborted) throw aborted();
		const result = await send();
		if (signal.aborted) throw aborted();
		trace.phase = 'complete';
		trace.elapsedMs = Math.round(performance.now() - start);
		return { ...result, exportRequest: publicExportRequest(trace)! };
	} catch (error) {
		trace.elapsedMs = Math.round(performance.now() - start);
		trace.abortReason = signal.aborted
			? signal.reason?.name === 'TimeoutError'
				? 'deadline'
				: 'cancelled'
			: 'none';
		trace.transportCode = exportTransportCode(error);
		const safe =
			error instanceof ExportOperationError
				? error
				: new ExportOperationError(
						'GetBucketVersioning',
						signal.aborted ? aborted() : error,
						'provider-error',
						'storage-unavailable',
						'namespace'
					);
		if (!safe.$metadata.httpStatusCode) safe.$metadata.httpStatusCode = trace.httpStatus;
		safe.request = publicExportRequest(trace);
		throw safe;
	}
}
