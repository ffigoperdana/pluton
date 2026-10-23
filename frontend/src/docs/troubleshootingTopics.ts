/** Static same-origin article links only. No diagnostic filename or Agent text
 * may become a URL, fragment, query parameter or command. */
export const troubleshootingTopics = {
   overview: { title: 'Troubleshooting overview', href: '/docs/troubleshooting' },
   source: { title: 'Source Access Troubleshooting Guide', href: '/docs/troubleshooting/source#1-understand-the-error' },
   permissions: { title: 'Source Access', href: '/docs/remote-agent/permissions' },
   exclusions: { title: 'Backup Exclusions', href: '/docs/troubleshooting/source#9-configure-backup-exclusions' },
   acl: { title: 'ACL Reference', href: '/docs/troubleshooting/source#6-inspect-acls' },
   diagnostics: { title: 'Source Diagnostics', href: '/docs/troubleshooting/source#4-find-inaccessible-entries' },
   recovery: { title: 'Recovery Verification', href: '/docs/troubleshooting/source#11-controlled-retry-and-recovery-verification' },
   databaseTls: { title: 'Database connection and TLS troubleshooting', href: '/docs/database-backup/connections#diagnostik' },
   agent: { title: 'Agent connectivity troubleshooting', href: '/docs/remote-agent/troubleshooting#offline' },
} as const;

const codeTopics: Readonly<Record<string, keyof typeof troubleshootingTopics>> = {
   'source-validation-failed': 'source',
   'source-parent-not-traversable': 'source',
   'source-root-not-readable': 'source',
   'source-entry-inaccessible': 'source',
   'source-missing': 'source',
   'source-symlink-escape': 'source',
   'source-unsupported-type': 'source',
   'source-policy-violation': 'source',
   'database-tls-verification-failed': 'databaseTls',
   'agent-unavailable': 'agent',
   'agent-offline': 'agent',
};

export function failureTroubleshootingTopic(code?: string) {
   return troubleshootingTopics[code && Object.prototype.hasOwnProperty.call(codeTopics, code) ? codeTopics[code] : 'overview'];
}

/** Shortcuts into the existing article collection, not duplicate articles. */
export const backupRecoveryTopics = [
   troubleshootingTopics.permissions,
   { ...troubleshootingTopics.source, title: 'Permission Troubleshooting' },
   troubleshootingTopics.exclusions,
   troubleshootingTopics.acl,
   troubleshootingTopics.diagnostics,
   troubleshootingTopics.recovery,
];
