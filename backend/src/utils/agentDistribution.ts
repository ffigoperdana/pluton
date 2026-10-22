import { AppError } from './AppError';

type DistributionConfig = {
	AGENT_INSTALL_REPOSITORY_URL?: string;
	AGENT_INSTALL_COMMIT?: string;
	AGENT_INSTALL_VERSION?: string;
	AGENT_INSTALL_CA_FILE?: string;
};
const hasControl = (value: string) =>
	Array.from(value).some(
		character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
	);

/** Public installation metadata only. Never pass Git credentials or enrollment secrets. */
export function agentDistribution(config: DistributionConfig) {
	const {
		AGENT_INSTALL_REPOSITORY_URL: repositoryUrl,
		AGENT_INSTALL_COMMIT: commit,
		AGENT_INSTALL_VERSION: version,
		AGENT_INSTALL_CA_FILE: caFile,
	} = config;
	const unavailable = () =>
		new AppError(
			503,
			'Standalone Agent distribution is unavailable. Configure a credential-free HTTPS Git repository, reviewed full commit SHA and supported Agent version (0.7.0).'
		);
	if (
		!repositoryUrl ||
		repositoryUrl.length > 2048 ||
		/[\s\\]/.test(repositoryUrl) ||
		hasControl(repositoryUrl)
	)
		throw unavailable();
	let url: URL;
	try {
		url = new URL(repositoryUrl);
	} catch {
		throw unavailable();
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		repositoryUrl.includes('?') ||
		repositoryUrl.includes('#') ||
		!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\.git$/.test(url.pathname) ||
		url.pathname.split('/').some(part => part === '.' || part === '..') ||
		url.href !== repositoryUrl ||
		!commit ||
		!/^[a-f0-9]{40}$/.test(commit) ||
		/^0+$/.test(commit) ||
		version !== '0.7.0'
	)
		throw unavailable();
	if (
		caFile &&
		(!caFile.startsWith('/') ||
			caFile.length > 1024 ||
			caFile.includes('\\') ||
			hasControl(caFile) ||
			caFile
				.slice(1)
				.split('/')
				.some(part => part === '.' || part === '..' || part === ''))
	)
		throw unavailable();
	return {
		repositoryUrl,
		commit,
		version,
		contract: 'pluton-agent-standalone-v1' as const,
		...(caFile ? { caFile } : {}),
	};
}
