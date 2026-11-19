/**
 * Restore to an Agent host (docs/AGENT_HOST_RESTORE.md). Pure helpers shared by the
 * Restore wizard and the database dump dialog. The server and the Agent re-check
 * every rule; these only give early, readable feedback.
 */

export type AgentHostRestoreRoot = { path: string; availableBytes?: number; availableInodes?: number };

export type AgentHostRestoreDatabase = {
   databaseId: string;
   engine?: string;
   database?: string;
   path: string;
   bytes: number;
   sha256: string;
};

export type AgentHostRestoreOptions = {
   supported: boolean;
   reason?: string;
   message?: string;
   agent: { hostname: string; agentVersion: string } | null;
   snapshotId: string;
   roots: AgentHostRestoreRoot[];
   unavailableRoots: { path: string; status: string; code?: string }[];
   suggestedName: string;
   databases: AgentHostRestoreDatabase[];
};

export type AgentHostRestoreRequest = {
   backupId: string;
   planId: string;
   root: string;
   name: string;
   includes?: string[];
   excludes?: string[];
   databaseId?: string;
};

export const AGENT_HOST_RESTORE_PARTIAL_SUFFIX = '.partial';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function agentHostRestoreNameProblem(name: string): string | undefined {
   if (!name) return 'Enter a folder name.';
   if (!NAME.test(name))
      return 'Use 1 to 100 letters, digits, dots, underscores or hyphens, starting with a letter or digit. No slashes or spaces.';
   if (name.endsWith(AGENT_HOST_RESTORE_PARTIAL_SUFFIX)) return 'The name must not end in .partial; that suffix marks an unfinished restore.';
   return undefined;
}

function isSelectionPath(value: string): boolean {
   return (
      value.startsWith('/') &&
      value !== '/' &&
      value.length <= 4096 &&
      !value.endsWith('/') &&
      !value.includes('//') &&
      !/[\u0000-\u001f\u007f*?[\]\\]/.test(value) &&
      !value
         .slice(1)
         .split('/')
         .some((part) => part === '' || part === '.' || part === '..')
   );
}

/** Same rules as the server and the Agent parser. */
export function agentHostSelectionProblem(selection: { includes: string[]; excludes: string[] }): string | undefined {
   const { includes, excludes } = selection;
   if (includes.length > 1024 || excludes.length > 1024) return 'The selection is too large for one restore.';
   if (![...includes, ...excludes].every(isSelectionPath)) return 'Select exact snapshot paths; names with *, ?, [, ] or \\ cannot be restored by path.';
   if (includes.length && excludes.length)
      return 'Restore to the Agent host restores either the selected items or everything except the deselected items, not both. Go back and select only the items to restore.';
   const within = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
   if (includes.some((entry) => includes.some((other) => other !== entry && within(other, entry))))
      return 'An item is selected inside another selected folder.';
   return undefined;
}

export function agentHostRestoreTarget(root: string, name: string): string {
   return `${root.replace(/\/+$/, '')}/${name}`;
}

export function agentHostRestoreScope(selection: { includes: string[]; excludes: string[] }, databasePath?: string): string {
   if (databasePath) return `the database dump ${databasePath}`;
   if (selection.includes.length) return `${selection.includes.length.toLocaleString('en-US')} selected item${selection.includes.length === 1 ? '' : 's'}`;
   if (selection.excludes.length)
      return `the whole snapshot except ${selection.excludes.length.toLocaleString('en-US')} deselected item${selection.excludes.length === 1 ? '' : 's'}`;
   return 'the whole snapshot';
}

function bytes(value: number): string {
   const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
   let amount = value;
   let unit = 0;
   while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit++;
   }
   return `${unit ? amount.toFixed(1) : amount} ${units[unit]}`;
}

export function agentHostRootLabel(root: AgentHostRestoreRoot): string {
   return root.availableBytes === undefined ? root.path : `${root.path} (${bytes(root.availableBytes)} free)`;
}

export function agentHostOptionsUrl(apiUrl: string, backupId: string, planId: string): string {
   const query = new URLSearchParams({ backupId, planId });
   return `${apiUrl}/restores/agent-host/options?${query.toString()}`;
}

/** Steps for the host administrator after a verified restore (docs/AGENT_HOST_RESTORE.md 7). */
export function agentHostOperatorSteps(target: string, databasePath?: string): string[] {
   const quoted = `'${target.replace(/'/g, `'\\''`)}'`;
   return [
      `sudo ls -la ${quoted}`,
      databasePath
         ? `sudo cat ${quoted}${databasePath} | sudo -u postgres psql --dbname=<new database>`
         : `sudo rsync -aH --chown=<owner>:<group> ${quoted}/<original path>/ <destination>/`,
      `sudo rm -rf --one-file-system ${quoted}`,
   ];
}

export function agentHostRequestBody(input: {
   backupId: string;
   planId: string;
   root: string;
   name: string;
   includes?: string[];
   excludes?: string[];
   databaseId?: string;
}): AgentHostRestoreRequest {
   return input.databaseId
      ? { backupId: input.backupId, planId: input.planId, root: input.root, name: input.name, databaseId: input.databaseId }
      : {
           backupId: input.backupId,
           planId: input.planId,
           root: input.root,
           name: input.name,
           includes: input.includes || [],
           excludes: input.excludes || [],
        };
}
