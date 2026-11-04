import { Readable } from 'stream';
import { SaxesParser } from 'saxes';
import type { CompletionShape } from './ExportCompletionShape';
import { CompleteMultipartUploadCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { ExportOperationError, exportHttpStatus, exportTarget } from './ExportDiagnostics';

/** Completion control XML only. Never inspect an object/download body. */
export const COMPLETION_BODY_LIMIT = 64 * 1024;
function initialShape(): CompletionShape {
	return {
		body: 'unavailable',
		xml: 'not-parsed',
		namespace: 'not-parsed',
		xmlParser: 'not-run',
		sdkParser: 'not-run',
		entityTagPresent: false,
		bucketPresent: false,
		keyPresent: false,
		identityUnique: false,
	};
}
function parse(body: Buffer, shape: CompletionShape): string | undefined {
	let depth = 0,
		elements = 0,
		root = '',
		rootNamespace = '',
		code = '',
		codeCount = 0,
		codeScalar = true,
		mixedResult = false;
	const fields: Record<string, number> = { ETag: 0, Bucket: 0, Key: 0 };
	let field = '',
		text = '';
	const parser = new SaxesParser({ xmlns: true });
	parser.on('error', () => {
		throw new Error('invalid completion XML');
	});
	parser.on('doctype', () => {
		throw new Error('invalid completion XML');
	});
	parser.on('opentag', tag => {
		if (++depth > 16 || ++elements > 256) throw new Error('invalid completion XML');
		if (depth === 1) {
			root = tag.local;
			rootNamespace = tag.uri;
		}
		if (depth > 1 && root === 'CompleteMultipartUploadResult' && tag.local === 'Error')
			throw new Error('invalid completion XML');
		if (
			depth > 1 &&
			(Object.hasOwn(fields, tag.local) || tag.local === 'CompleteMultipartUploadResult')
		)
			mixedResult = true;
		if (depth === 2) {
			if (tag.local === 'Code') {
				codeCount++;
				if (
					tag.uri !== rootNamespace ||
					Object.values(tag.attributes).some(a => a.uri !== 'http://www.w3.org/2000/xmlns/')
				)
					codeScalar = false;
			}
			if (Object.hasOwn(fields, tag.local) && tag.uri !== rootNamespace)
				throw new Error('invalid completion XML');
			field = tag.uri === rootNamespace ? tag.local : '';
			text = '';
			if (Object.hasOwn(fields, field)) fields[field]++;
		}
		// Identity and error codes must be scalar direct children, not nested XML.
		if (depth > 2 && (Object.hasOwn(fields, field) || field === 'Code'))
			throw new Error('invalid completion XML');
	});
	const content = (value: string) => {
		if (depth === 2) text += value;
	};
	parser.on('text', content);
	parser.on('cdata', content);
	parser.on('closetag', () => {
		if (depth === 2 && field === 'Code') code = text;
		depth--;
	});
	try {
		// Reject invalid UTF-8 instead of silently replacing bytes before parsing.
		parser.write(new TextDecoder('utf-8', { fatal: true }).decode(body)).close();
		shape.xmlParser = 'accepted';
		shape.xml =
			root === 'CompleteMultipartUploadResult' ? 'result' : root === 'Error' ? 'error' : 'other';
		shape.namespace = !rootNamespace
			? 'none'
			: rootNamespace === 'http://s3.amazonaws.com/doc/2006-03-01/'
				? 's3'
				: rootNamespace === 'http://s3.amazonaws.com/doc/2020-09-01/'
					? 'hcp'
					: 'unsupported';
		shape.entityTagPresent = fields.ETag > 0;
		shape.bucketPresent = fields.Bucket > 0;
		shape.keyPresent = fields.Key > 0;
		shape.identityUnique = Object.values(fields).every(n => n <= 1);
		shape.operationAbortedVerified =
			shape.xml === 'error' &&
			shape.namespace !== 'unsupported' &&
			codeCount === 1 &&
			codeScalar &&
			code === 'OperationAborted' &&
			!mixedResult;
		return code;
	} catch {
		shape.xmlParser = 'rejected';
		shape.xml = 'malformed';
	}
}

/** Observe the wire BEFORE S3's throw200ExceptionsMiddleware (which rewrites
 * some 200 Error bodies to 503). A complete XML Error remains a wire-200 error,
 * never a publication success. Only a precise final error can carry semantic
 * rejection evidence; the race separately verifies its context and ownership. */
export async function checkedCompletion(
	command: CompleteMultipartUploadCommand,
	signal: AbortSignal,
	send: () => Promise<any>
) {
	let wireHttpStatus: number | undefined;
	let shape: CompletionShape = initialShape();
	let requestAttempts = 0,
		replayBlocked = false;
	command.middlewareStack.addRelativeTo(
		(next: (args: any) => Promise<any>) => async (args: any) => {
			// This deserialize middleware runs inside the SDK retry middleware.
			// Block a second dispatch even if an SDK configuration regresses later.
			if (requestAttempts) {
				replayBlocked = true;
				if (shape.body === 'complete') shape.sdkParser = 'rejected';
				const error = new ExportOperationError(
					'CompleteMultipartUpload',
					{},
					'completion-replay-blocked'
				);
				error.responseKind = 'body-invalid';
				throw error;
			}
			requestAttempts++;
			const result = await next(args);
			const response = result.response;
			wireHttpStatus = exportHttpStatus({ $metadata: { httpStatusCode: response?.statusCode } });
			shape = initialShape();
			const observation = shape;
			const failure = (error: unknown, embedded = false) => {
				const safe = new ExportOperationError(
					'CompleteMultipartUpload',
					error,
					embedded ? 'provider-error' : 'completion-body-invalid',
					'storage-unavailable',
					exportTarget(command.input.Key)
				);
				safe.responseKind = embedded ? 'embedded-error' : 'body-invalid';
				return safe;
			};
			const raw = response?.body;
			const body =
				raw instanceof Readable
					? raw
					: typeof raw === 'string' || raw instanceof Uint8Array
						? Readable.from([raw])
						: undefined;
			if (!body) throw failure({ $metadata: { httpStatusCode: wireHttpStatus } });
			const abort = () =>
				body.destroy(Object.assign(new Error('completion aborted'), { name: 'AbortError' }));
			signal.addEventListener('abort', abort, { once: true });
			const chunks: Buffer[] = [];
			let bytes = 0;
			try {
				if (signal.aborted) abort();
				for await (const chunk of body) {
					bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
					if (bytes > COMPLETION_BODY_LIMIT) {
						observation.body = 'too-large';
						throw failure({ $metadata: { httpStatusCode: wireHttpStatus } });
					}
					chunks.push(Buffer.from(chunk));
				}
			} catch (error) {
				if (observation.body !== 'too-large') observation.body = 'incomplete';
				throw error;
			} finally {
				signal.removeEventListener('abort', abort);
				body.destroy();
			}
			const length = response.headers?.['content-length'];
			if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== bytes)) {
				observation.body = 'incomplete';
				throw failure({ $metadata: { httpStatusCode: wireHttpStatus } });
			}
			observation.body = bytes ? 'complete' : 'empty';
			const collected = Buffer.concat(chunks);
			const code = bytes ? parse(collected, observation) : undefined;
			if (
				wireHttpStatus === 200 &&
				(observation.xml !== 'result' ||
					observation.namespace === 'unsupported' ||
					!observation.identityUnique)
			) {
				throw failure(
					{ name: code, $metadata: { httpStatusCode: 200 } },
					observation.xml === 'error'
				);
			}
			// The pinned SDK still deserializes every accepted result. Never fill in
			// missing SDK identity values from HEAD, request input or this XML parser.
			response.body = Readable.from([collected]);
			return result;
		},
		{
			relation: 'after',
			toMiddleware: 'throw200ExceptionsMiddleware',
			name: 'exportCompletionBody',
		}
	);
	try {
		const result = await send();
		shape.sdkParser = 'resolved';
		shape.requestAttempts = requestAttempts;
		shape.replayBlocked = replayBlocked;
		return { ...result, exportWireHttpStatus: wireHttpStatus, exportCompletionShape: shape };
	} catch (error) {
		const safe =
			error instanceof ExportOperationError
				? error
				: new ExportOperationError(
						'CompleteMultipartUpload',
						error,
						'provider-error',
						'storage-unavailable',
						exportTarget(command.input.Key)
					);
		if (
			!(error instanceof ExportOperationError) &&
			error &&
			typeof error === 'object' &&
			Object.hasOwn(error, '$response') &&
			!(error instanceof S3ServiceException) &&
			safe.providerCategory === 'service-error'
		)
			safe.responseKind = 'sdk-parsing-error';
		if (
			shape &&
			shape.sdkParser === 'not-run' &&
			!['body-invalid', 'embedded-error'].includes(safe.responseKind || '') &&
			shape.body === 'complete'
		)
			shape.sdkParser = 'rejected';
		safe.wireHttpStatus = wireHttpStatus;
		shape.requestAttempts = requestAttempts;
		shape.replayBlocked = replayBlocked;
		safe.requestAttempts = requestAttempts;
		safe.completionShape = shape;
		throw safe;
	}
}
