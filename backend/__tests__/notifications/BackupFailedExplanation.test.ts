import { readFileSync } from 'fs';
import path from 'path';
import { BackupFailedNotification } from '../../src/notifications/templates/email/backup/BackupFailedNotification';
import { loadBackupTemplate } from '../../src/notifications/templateLoader';
import { problemFromErrorText } from '../../src/notifications/problemExplanations';

jest.mock('../../src/services/ConfigService', () => ({
	configService: { config: { APP_TITLE: 'Ops', APP_URL: 'https://backup.example.internal/' } },
}));

const template = readFileSync(
	path.join(
		__dirname,
		'../../src/notifications/templates/email/backup/BackupFailedNotification.ejs'
	),
	'utf8'
);
const plan = {
	id: 'plan-01',
	title: 'Example Application',
	method: 'backup',
	sourceConfig: { includes: ['/srv/example-app'], excludes: [] },
	storagePath: 'example-app',
	settings: {},
} as any;
const render = (error: string) =>
	new BackupFailedNotification({
		appTitle: 'Ops',
		deviceName: 'app-01',
		storageName: 'Primary SFTP',
		storageType: 'sftp',
		plan,
		startTime: new Date('2026-11-25T07:30:00Z'),
		endTime: new Date('2026-11-25T07:32:00Z'),
		error,
	}).getContent();

describe('Backup Failed email explanation', () => {
	beforeEach(() => jest.mocked(loadBackupTemplate).mockReturnValue(template));

	it('finds the closed category in a recorded error and explains it', () => {
		expect(
			problemFromErrorText(
				'Storage authentication failed. (repository-target-check/target-check-auth-failed).'
			)?.title
		).toBe('The storage login failed');
		expect(
			problemFromErrorText(
				'Database authentication failed. (database-dump/database-auth-failed; databaseId=db_main; engine=mysql).'
			)?.title
		).toBe('The database rejected the backup login');
		expect(problemFromErrorText('Fatal: unable to open config file')).toBeUndefined();
		expect(problemFromErrorText(undefined)).toBeUndefined();
	});

	it('adds what happened, what to do and a guide link under the recorded error', () => {
		const html = render(
			'The source root is not readable/traversable by pluton-agent. (source-validation/source-root-not-readable).'
		);

		expect(html).toContain('Error: The source root is not readable');
		expect(html).toContain('The source folder cannot be read');
		expect(html).toContain('What to do');
		expect(html).toContain('Grant pluton-agent read and traverse access');
		expect(html).toContain(
			'href="https://backup.example.internal/docs/troubleshooting/source#1-understand-the-error"'
		);
	});

	it('keeps the email unchanged when the error has no known category', () => {
		const html = render('Fatal: unable to open config file');

		expect(html).toContain('Error: Fatal: unable to open config file');
		expect(html).not.toContain('What to do');
	});
});
