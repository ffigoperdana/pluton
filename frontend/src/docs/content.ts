import { createDocsIndex } from './model';
const files = import.meta.glob('./articles/**/*.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const content = Object.fromEntries(Object.entries(files).map(([filename, markdown]) => [filename.slice('./articles/'.length, -3), markdown]));
export const docsIndex = createDocsIndex(content);
