# Replication: progress watchdog instead of a fixed 30-minute limit

## 1. Symptom

The first copy of a larger Managed Agent plan to an S3/HCP replica failed with `timeout` after
exactly 30 minutes (a plan of about 3.2 GB logical, about 1.1 GB stored after deduplication and
compression). An explicit Retry then completed, and the plan's older backups copied in a few
minutes each, because Restic had already recorded most of the uploaded data. Plans that are much
larger (tens to hundreds of GB) would need a long series of manual retries for their first copy.

## 2. Cause (proven from code)

Two fixed 30-minute limits applied to every replication job:

- `ManagedReplicationService.runTick` aborted the whole job after 30 minutes
  (`controller.abort('timeout')`), and `enqueueBackup` did the same for source admission.
- `ManagedReplicationExecutor.command` stopped every long command (`copy`, `init`, SQL artifact
  `dump`) after 30 minutes.

A fixed limit cannot tell a slow first copy from a stuck one. The measured case implies an
effective upload rate to HCP below about 0.6 MiB/s (1.1 GiB did not finish in 30 minutes), so a
first copy of 20 GB stored takes roughly 10 hours.

## 3. Change

New module `backend/src/utils/restic/replicationProgress.ts`:

- `REPLICATION_PROGRESS` holds the limits: sample every 15 s; stall after 10 minutes; progress means
  at least 1 MiB of I/O or 30 s of CPU since the last progress mark; absolute limit 24 hours; the
  previous 30 minutes as the fallback.
- `createProgressTracker` turns samples into `unobservable`, `active` or `stalled`. A process is
  identified by PID and start time, so a reused PID never counts as progress.
- `sampleProcessTree` reads `/proc/<pid>/stat` and `/proc/<pid>/io` (`rchar` + `wchar`, CPU ticks)
  of the managed Restic process and its direct Rclone children. It reuses the existing reader from
  `archiveProcessObservation.ts` (now exported as `readProcessCounters`). Nothing is logged or
  returned to a client.

`ManagedReplicationExecutor.command`, for long commands only:

- While counters are unobservable (not Linux, or `/proc` unreadable), the previous fixed 30-minute
  limit stays in force, so behaviour is never worse than before.
- Once counters are observed, the fixed limit is replaced by the 24-hour absolute limit (counted
  from the command start) and the command is stopped with the new code `stalled` when the tracker
  reports a stall.
- Short commands (`cat config`, `snapshots`, `rclone obscure`, `lsf`) keep their 60-second limit.

`ManagedReplicationService`: the job limit and the admission limit are `REPLICATION_PROGRESS.limitMs`
(24 hours) instead of 30 minutes.

In-app documentation: `frontend/src/docs/articles/replication/status-retry.md` explains `stalled`
and `timeout`.

### Behaviour

| Situation | Before | After |
| --- | --- | --- |
| First copy keeps uploading for 6 hours | `timeout` at 30 min, manual retry | runs to completion |
| Restic/Rclone wait with no I/O and no CPU | stopped at 30 min (`timeout`) | stopped after 10 min (`stalled`) |
| Restic retry loop moving a few KB per attempt | stopped at 30 min | stopped after 10 min (`stalled`) |
| Job keeps moving for more than 24 hours | n/a | `timeout`; Retry continues from recorded data |
| Counters unreadable | 30 min | 30 min (unchanged) |

Both codes end as `failed`, so the queue slot is released and Retry is allowed. A stop that cannot
prove every child exited still ends as `uncertain`, exactly as before.

## 4. Limitations

- Replication has one slot for the whole server. While a multi-hour first copy runs, every other
  plan's replication waits behind it. Enable replication for a very large plan at a quiet time.
- After a `stalled` or `timeout` stop, Restic keeps what it recorded in its preliminary indexes
  (written about every 10 minutes during a long copy). Data uploaded after the last index is sent
  again on Retry and the earlier copy of it stays as unused objects in the replica.
- The upload rate to the replica is the real bound. A plan of hundreds of GB stored can need more
  than one 24-hour run for its first copy.
- No automatic retry was added; Retry stays explicit.

## 5. Validation

| Check | Result |
| --- | --- |
| New tracker tests `replicationProgress.test.ts` | 7 passed; the Linux sampling test runs in CI (skipped on Windows) |
| Process tests (real child, injected sampler): stall, progress beyond the old limit, unobservable fallback, absolute limit, short commands unwatched | pass |
| Service test: job not aborted at 6 hours, aborted at the 24-hour limit as `failed`/`timeout` | pass |
| Replication suites (executor, process, service, progress) | 95 passed, 2 skipped (Linux-only) |
| Linux probe in the lab image with the production container restrictions (read-only, `--cap-drop ALL`, `no-new-privileges`, UID 1000) | 4/4: live counters readable; real Restic with its Rclone child sampled (2 processes); idle real Rclone stopped as `stalled`; real Rclone copy throttled to 8 MiB/s ran past a 1.5 s legacy limit and completed |
| Replica recovery lab `scripts/validate-replica-recovery.py` (current source mounted) | 18/18 PASS |
| Full backend suite `--runInBand` | 236/237 suites, 4,980 passed, 6 skipped; the one failing suite is the known `PlanService` Pino teardown timeout, which passes alone (80/80) |
| Frontend tests `node --experimental-strip-types --test frontend/__tests__/*.test.ts` | 490/490 |
| Backend `tsc --noEmit`, ESLint and Prettier on changed files | pass (one pre-existing Prettier difference in the executor left untouched) |

### 5.1 Lab

Docker, network none, read-only, real Restic 0.19.1 and Rclone, current source mounted into
`pluton-s3-readback-verified:local`: all 18 scenarios PASS, including "real SFTP-to-HTTPS-S3 Restic
copy, private CA, destination mapping and recovery preflight", which now runs the copy and the SQL
artifact reads under the progress watchdog.

## 6. Deployment and UAT

- Server only. No migration, no Agent update, no `.env` or Compose change.
- Do not redeploy while replication jobs are running: a restart turns a running job into
  `uncertain` (`execution-interrupted`), which holds the queue. Check that `pending` and `running`
  are 0 first.
- UAT: enable replication for a plan whose first copy needs more than 30 minutes, then confirm in
  `/data/logs/app.log` that `managed_replication_job_completed` reports a `durationMs` above
  1,800,000 and the mirror shows Completed.

## 7. Rollback

Redeploy the previous image. No data or schema change is involved. A job running at the time of
the restart becomes `uncertain`, as with any restart.
