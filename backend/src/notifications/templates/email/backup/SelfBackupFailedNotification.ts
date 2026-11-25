import ejs from 'ejs';
import { configService } from '../../../../services/ConfigService';
import { BaseNotification } from '../../../BaseNotification';
import { loadBackupTemplate } from '../../../templateLoader';
import { BRAND_NAME } from '../../../../utils/brand';

export interface SelfBackupFailedNotificationPayload {
	appTitle: string;
	error: string;
	hostname?: string;
	storageName?: string;
	/** When the run failed. Defaults to now if omitted. */
	failedAt?: Date;
}

/**
 * Emailed to the admin when Pluton's own self-backup run fails, if the failure-notification
 * toggle is enabled. Email-only: unlike the plan notifications this never fans out to push
 * or chat channels, so only the HTML body is built.
 */
export class SelfBackupFailedNotification extends BaseNotification {
	constructor(data: SelfBackupFailedNotificationPayload) {
		super();
		this.type = 'error';
		this.subject = `${data.appTitle || BRAND_NAME} Self-Backup Failed`;
		this.content = this.buildContent(data);
	}

	protected buildContent(data: SelfBackupFailedNotificationPayload): string {
		const failedAt = new Date(data.failedAt ?? Date.now()).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'long',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
		});

		const templateString = loadBackupTemplate('SelfBackupFailedNotification.ejs');
		const renderedBody = ejs.render(templateString, {
			...data,
			appUrl: configService.config.APP_URL || '',
			failedAt,
		});

		return this.applyEmailTemplate(renderedBody, {
			appTitle: data.appTitle || configService.config.APP_TITLE || BRAND_NAME,
			preHeader: `${data.appTitle || BRAND_NAME} could not back up its own configuration.`,
			className: 'content--error',
		});
	}
}
