import { configService } from '../services/ConfigService';
import { loadEmailWrapperTemplate } from './templateLoader';
import { BRAND_NAME } from '../utils/brand';

const escapeHtml = (value: string) =>
	value.replace(
		/[&<>"']/g,
		char =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string
	);

export type EmailWrapperData = { appTitle: string; preHeader?: string; className?: string };

/**
 * Fills the shared email wrapper (email.html) around already-rendered body HTML.
 * Every occurrence is filled (the footer uses {{APP_URL}} twice). Values go through a
 * replacer function so `$&`, `$'` or `$$` in a plan title or error text stay literal.
 * The body is inserted last, so text inside it is never treated as a placeholder.
 */
export function fillEmailWrapper(
	template: string,
	content: string,
	data: EmailWrapperData
): string {
	if (!template) return content;
	const currentDate = new Date().toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});
	const fill = (html: string, placeholder: string, value: string) =>
		html.replaceAll(placeholder, () => value);
	const placeholders: [string, string][] = [
		['{{CLASSNAME}}', escapeHtml(data.className || '')],
		['{{BRAND_NAME}}', escapeHtml(BRAND_NAME)],
		// The header reads "<brand> <instance title>"; skip the title when it repeats the brand.
		['{{APP_TITLE}}', escapeHtml(data.appTitle === BRAND_NAME ? '' : data.appTitle || '')],
		['{{CURRENT_DATE}}', escapeHtml(currentDate)],
		['{{APP_URL}}', escapeHtml(configService.config.APP_URL || '')],
		['{{PRE_HEADER}}', escapeHtml(data.preHeader || '')],
	];
	const filled = placeholders.reduce(
		(html, [placeholder, value]) => fill(html, placeholder, value),
		template
	);
	return fill(filled, '{{EMAIL_BODY_CONTENT}}', content);
}

export abstract class BaseNotification {
	protected subject: string = '';
	protected contentType: string = 'html';
	protected content: string = '';
	protected timestamp: Date;
	protected type: 'success' | 'error' | 'info' | 'warning' | 'test' = 'test';

	constructor() {
		this.timestamp = new Date();
	}

	getSubject(): string {
		return this.subject;
	}

	getContent(): string {
		return this.content;
	}

	getTimestamp(): Date {
		return this.timestamp;
	}

	getType(): string {
		return this.type;
	}

	protected loadEmailTemplate(): string {
		return loadEmailWrapperTemplate();
	}

	protected applyEmailTemplate(content: string, data: EmailWrapperData): string {
		return fillEmailWrapper(this.loadEmailTemplate(), content, data);
	}

	protected buildContent(data: Record<string, any>): string {
		// Override in specific notification classes
		return '';
	}
}
