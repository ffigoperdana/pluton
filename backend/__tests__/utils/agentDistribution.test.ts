import {
	agentDistribution,
	SUPPORTED_AGENT_INSTALL_VERSIONS,
} from '../../src/utils/agentDistribution';

const valid = {
	AGENT_INSTALL_REPOSITORY_URL: 'https://git.example.internal/agents/pluton-agent.git',
	AGENT_INSTALL_COMMIT: 'a'.repeat(40),
	AGENT_INSTALL_VERSION: '0.7.0',
};

describe('Standalone enrollment distribution (new installs only)', () => {
	it('returns only pinned public metadata and an optional host CA path', () => {
		expect(
			agentDistribution({ ...valid, AGENT_INSTALL_CA_FILE: '/etc/ssl/example CA.pem' })
		).toEqual({
			repositoryUrl: valid.AGENT_INSTALL_REPOSITORY_URL,
			commit: valid.AGENT_INSTALL_COMMIT,
			version: '0.7.0',
			contract: 'pluton-agent-standalone-v1',
			caFile: '/etc/ssl/example CA.pem',
		});
	});
	it('allows exactly the reviewed standalone releases', () => {
		expect(SUPPORTED_AGENT_INSTALL_VERSIONS).toEqual(['0.7.0', '0.7.1']);
	});
	it.each(['0.7.0', '0.7.1'])(
		'passes reviewed standalone version %s through unchanged for the host-side check',
		version => {
			expect(agentDistribution({ ...valid, AGENT_INSTALL_VERSION: version })).toEqual({
				repositoryUrl: valid.AGENT_INSTALL_REPOSITORY_URL,
				commit: valid.AGENT_INSTALL_COMMIT,
				version,
				contract: 'pluton-agent-standalone-v1',
			});
		}
	);
	it('names every supported version in the sanitized refusal', () => {
		expect(() => agentDistribution({ ...valid, AGENT_INSTALL_VERSION: '0.7.2' })).toThrow(
			'supported Agent version (0.7.0 or 0.7.1)'
		);
	});
	it.each([
		{},
		{ AGENT_INSTALL_COMMIT: '' },
		{ AGENT_INSTALL_COMMIT: 'main' },
		{ AGENT_INSTALL_COMMIT: 'a'.repeat(39) },
		{ AGENT_INSTALL_COMMIT: '0'.repeat(40) },
		...[
			'',
			'0.8.0',
			'0.7.2',
			'0.6.9',
			'0.7',
			'0.7.1-dev',
			'v0.7.1',
			' 0.7.1',
			'0.7.1\n',
			'latest',
		].map(AGENT_INSTALL_VERSION => ({ AGENT_INSTALL_VERSION })),
		...[
			'http://git.example.internal/a.git',
			'https://credential@git.example.internal/a.git',
			'https://git.example.internal/a.git?token=synthetic',
			'https://git.example.internal/a.git#main',
			'https://git.example.internal/a/../b.git',
			'file:///tmp/a.git',
			'ssh://git@git.example.internal/a.git',
			'https://git.example.internal/a.git\n',
		].map(AGENT_INSTALL_REPOSITORY_URL => ({ AGENT_INSTALL_REPOSITORY_URL })),
		...['relative.pem', '/etc/../ca.pem', '/tmp//ca.pem', '/tmp/ca\n.pem'].map(
			AGENT_INSTALL_CA_FILE => ({ AGENT_INSTALL_CA_FILE })
		),
	])('rejects invalid configuration without reflecting sensitive input: %j', patch => {
		const input = Object.keys(patch).length ? { ...valid, ...patch } : {};
		expect(() => agentDistribution(input)).toThrow('Standalone Agent distribution is unavailable');
		try {
			agentDistribution(input);
		} catch (error: any) {
			expect(error.statusCode).toBe(503);
			expect(error.message).not.toContain('credential@');
			expect(error.message).not.toContain('token=synthetic');
		}
	});
});
