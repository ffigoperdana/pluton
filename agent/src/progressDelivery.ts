/** One in-flight event and one coalesced pending event. Progress outages do not undo data-plane work. */
export class ProgressDelivery {
  private pending?: Record<string, unknown>;
  private draining?: Promise<void>;
  private lastSent = -Infinity;
  constructor(
    private readonly send: (event: Record<string, unknown>) => Promise<void>,
    private readonly onFailure: () => void,
    private readonly intervalMs = 1000,
  ) {}
  enqueue(event: Record<string, unknown>): void {
    this.pending = { ...this.pending, ...event };
    if (!this.draining) this.start();
  }
  private start(): void {
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.pending) this.start();
    });
  }
  private async drain(): Promise<void> {
    while (this.pending) {
      const delay = this.lastSent + this.intervalMs - Date.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const event = this.pending;
      this.pending = undefined;
      this.lastSent = Date.now();
      try {
        await this.send(event);
      } catch {
        try {
          this.onFailure();
        } catch {
          /* Diagnostics are also best-effort. */
        }
      }
    }
  }
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }
}

export function backupProgressStage(stage: string): string {
  const stages: Record<string, string> = {
    "payload-validation": "preparing-backup",
    "source-validation": "validating-source",
    "state-validation": "validating-source",
    "tool-validation": "preparing-storage",
    "sftp-password-obscure": "preparing-storage",
    "temporary-storage-config": "preparing-storage",
    "repository-check": "checking-existing-snapshot",
    "lifecycle-validation": "preparing-database",
    "workspace-creation": "preparing-database",
    "pre-backup": "pre-backup",
    "database-dump": "dumping-database",
    "database-dump-validation": "dumping-database",
    "post-dump-status-check": "preparing-repository",
    "command-status-check": "preparing-backup",
    "repository-target-check": "preparing-repository",
    "repository-initialization": "preparing-repository",
    "parent-discovery": "preparing-repository",
    "parent-verification": "preparing-repository",
    "restic-backup": "backing-up",
    "snapshot-confirmation": "verifying-snapshot",
    "post-backup": "post-backup",
    cleanup: "cleanup",
  };
  return stages[stage] || "preparing-backup";
}
