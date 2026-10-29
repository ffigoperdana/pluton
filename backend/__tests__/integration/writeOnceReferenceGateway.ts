/** Disposable reference CONTRACT gateway in front of native MinIO. It models
 * first-writer-wins and an S3 API without conditional DELETE; it is NOT HCP and
 * cannot certify HCP compatibility. No production code imports this fixture. */
import https from 'node:https';
import fs from 'node:fs/promises';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export async function writeOnceReferenceGateway(
	endpoint: string,
	ca: Buffer,
	bucket: string,
	prefix: string
) {
	const upstream = new URL(endpoint);
	if (
		upstream.hostname !== 'minio' ||
		bucket !== 'example-private-exports' ||
		prefix !== 'pluton-temporary-exports'
	)
		throw new Error('Reference gateway accepts only its disposable fixture.');
	const admin = new S3Client({
		endpoint,
		region: 'us-east-1',
		forcePathStyle: true,
		maxAttempts: 1,
		credentials: {
			accessKeyId: process.env.FIXTURE_ADMIN_ACCESS!,
			secretAccessKey: process.env.FIXTURE_ADMIN_SECRET!,
		},
		requestHandler: new NodeHttpHandler({
			httpsAgent: new https.Agent({ ca, rejectUnauthorized: true }),
		}),
	});
	const locks = new Set<string>();
	const gateway = https.createServer(
		{ cert: ca, key: await fs.readFile('/lab/tls/private.key') },
		async (request, response) => {
			const url = new URL(request.url!, 'https://fixture.invalid');
			const segments = url.pathname.slice(1).split('/').map(decodeURIComponent);
			const key = segments.slice(1).join('/');
			const guarded = segments[0] === bucket && key.startsWith(prefix + '/');
			const commit =
				guarded &&
				((request.method === 'PUT' && !url.searchParams.has('uploadId')) ||
					(request.method === 'POST' && url.searchParams.has('uploadId')));
			let locked = false;
			const error = (status: number) => {
				request.resume();
				response.writeHead(status, { 'Content-Type': 'application/xml', 'Connection': 'close' });
				response.end(
					'<Error><Code>OperationAborted</Code><Message>Disposable reference collision</Message></Error>'
				);
			};
			try {
				if (
					guarded &&
					request.method === 'DELETE' &&
					!url.searchParams.has('uploadId') &&
					request.headers['if-match']
				)
					return error(400);
				if (commit) {
					if (locks.has(key)) return error(409);
					locks.add(key);
					locked = true;
					try {
						await admin.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
						return error(409);
					} catch (e) {
						if ((e as any).$metadata?.httpStatusCode !== 404) throw e;
					}
				}
				// HCP may ignore AWS completion headers; the client must not rely on them.
				// Conditional DELETE is unsupported so bounded cleanup is exercised.
				const headers = { ...request.headers };
				await new Promise<void>((resolve, reject) => {
					const forwarded = https.request(
						new URL(request.url!, upstream),
						{
							method: request.method,
							headers,
							ca,
							rejectUnauthorized: true,
							servername: upstream.hostname,
						},
						result => {
							response.writeHead(result.statusCode!, result.headers);
							result.on('error', reject);
							response.on('error', reject);
							result.on('end', resolve);
							result.pipe(response);
						}
					);
					forwarded.on('error', reject);
					request.on('error', reject);
					request.pipe(forwarded);
				});
			} catch {
				if (!response.headersSent) error(502);
				else response.destroy();
			} finally {
				if (locked) locks.delete(key);
			}
		}
	);
	await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
	const address = gateway.address() as { port: number };
	return {
		endpoint: `https://127.0.0.1:${address.port}`,
		close: async () => {
			admin.destroy();
			gateway.closeAllConnections();
			await new Promise<void>(resolve => gateway.close(() => resolve()));
		},
	};
}
