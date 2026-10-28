# Local fixture readiness only; do not emit raw inspect/environment/log/config contents.
function Wait-MysqlFixtureWorker {
    param(
        [Parameter(Mandatory)][string]$Container,
        [ValidateRange(1,120)][int]$DeadlineSeconds = 60,
        # Synthetic tests supply monotonic time and a delay without sleeping.
        # Native fixture callers retain the real clock, deadline and 250 ms poll.
        [scriptblock]$StartClock = { [Diagnostics.Stopwatch]::StartNew() },
        [scriptblock]$PollDelay = { Start-Sleep -Milliseconds 250 }
    )
    $clock = & $StartClock
    $lastProbe = $null
    while ($clock.Elapsed.TotalSeconds -lt $DeadlineSeconds) {
        $stateJson = & docker inspect --format '{{json .State}}' $Container 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Disposable worker startup failed (stage=container-inspect).' }
        try { $state = $stateJson | ConvertFrom-Json } catch { throw 'Disposable worker startup failed (stage=container-inspect).' }
        if ($state.Status -notin @('created','running','exited','dead','restarting','paused','removing') -or
            ($state.ExitCode -isnot [long] -and $state.ExitCode -isnot [int])) { throw 'Disposable worker startup failed (stage=container-inspect).' }
        if (-not $state.Running -and $state.Status -notin @('created','restarting')) {
            $stage = 'worker-process'
            # Parse only the exact closed startup event emitted by the worker.
            $records = & docker logs --since $state.StartedAt --tail 20 $Container 2>&1
            foreach ($line in $records) {
                try { $record = "$line" | ConvertFrom-Json -ErrorAction Stop } catch { continue }
                if ($record.event -eq 'mysql-worker-startup' -and $record.status -eq 'refused' -and
                    $record.stage -in @('module-loading','configuration','trust','identity','native-client','ipc-directory','ipc-socket')) { $stage = $record.stage }
            }
            throw "Disposable worker startup failed (stage=$stage; status=$($state.Status); exit=$($state.ExitCode); oom=$([bool]$state.OOMKilled))."
        }
        if ($state.Running) {
            $probeJson = & docker exec $Container node /fixture-code/mysqlRecoveryWorker.startup.mjs 2>$null
            if ($LASTEXITCODE -eq 0) {
                try { $lastProbe = $probeJson | ConvertFrom-Json } catch { throw 'Disposable worker startup failed (stage=ipc-probe).' }
                if ($lastProbe.stage -notin @('waiting','binding','identity','ipc-directory','configuration','trust','ipc-socket','socket-present')) {
                    throw 'Disposable worker startup failed (stage=ipc-probe).'
                }
                if ($lastProbe.stage -in @('identity','ipc-directory','configuration','trust','ipc-socket')) {
                    # Numeric metadata only; never return file contents, names or configuration.
                    throw "Disposable worker startup failed (stage=$($lastProbe.stage); status=running; ipc-uid=$($lastProbe.ipc.uid); ipc-gid=$($lastProbe.ipc.gid); ipc-mode=$($lastProbe.ipc.mode))."
                }
                if ($lastProbe.stage -eq 'socket-present') {
                    # A restart can leave a stale socket. The fresh process must announce
                    # readiness after bind/chmod; socket existence alone is insufficient.
                    $records = & docker logs --since $state.StartedAt --tail 20 $Container 2>&1
                    foreach ($line in $records) {
                        try { $record = "$line" | ConvertFrom-Json -ErrorAction Stop } catch { continue }
                        if ($record.event -eq 'mysql-worker-startup' -and $record.stage -eq 'ready' -and $record.status -eq 'ready') { return }
                    }
                }
            }
        }
        & $PollDelay
    }
    $stage = if ($lastProbe -and $lastProbe.stage -eq 'socket-present') { 'ready-signal-timeout' } else { 'socket-timeout' }
    throw "Disposable worker startup failed (stage=$stage; status=$($state.Status); exit=$($state.ExitCode); oom=$([bool]$state.OOMKilled); deadline-seconds=$DeadlineSeconds)."
}
