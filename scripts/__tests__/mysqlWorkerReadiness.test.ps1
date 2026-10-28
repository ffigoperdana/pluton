$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../mysql-worker-readiness.ps1')
function Assert([bool]$ok, [string]$check) {
    if (-not $ok) { $script:failedCheck = $check; throw 'Synthetic readiness assertion failed.' }
}
trap {
    # Closed test labels only: never print the exception or captured Docker output.
    Write-Output "READINESS failure scenario=$script:scenario profile=$script:profile check=$script:failedCheck"
    exit 1
}
function Start-Sleep { throw 'Synthetic readiness scenarios must not sleep.' }
function docker {
    if ($script:profile -eq 'busy') {
        # Add CPU work/yield points without advancing the scenario's clock.
        # Scheduler latency must not decide how many synthetic polls fit.
        [Threading.Thread]::SpinWait(10000)
        [void][Threading.Thread]::Yield()
    }
    $global:LASTEXITCODE = 0
    switch ($args[0]) {
        'inspect' {
            $script:polls++
            $exited = $script:scenario -in @('exit','configuration','native-client','module-loading','oom')
            $status = if ($exited) {'exited'} else {'running'}
            @{Running=(-not $exited);Status=$status;ExitCode=1;OOMKilled=($script:scenario -eq 'oom');StartedAt='2026-01-01T00:00:00Z'} | ConvertTo-Json -Compress
        }
        'logs' {
            'synthetic-private-provider-output synthetic-password'
            if ($script:scenario -in @('configuration','native-client','module-loading')) {
                @{event='mysql-worker-startup';stage=$script:scenario;status='refused'} | ConvertTo-Json -Compress
            } elseif ($script:scenario -in @('ready','delayed','permission')) {
                @{event='mysql-worker-startup';stage='ready';status='ready'} | ConvertTo-Json -Compress
            }
        }
        'exec' {
            $stage = switch ($script:scenario) {
                'ready' {'socket-present'}
                'delayed' {if($script:polls -lt 3){'binding'}else{'socket-present'}}
                'permission' {'ipc-directory'}
                'stale-socket' {'socket-present'}
                default {'waiting'}
            }
            @{stage=$stage;ipc=@{uid=10001;gid=10001;mode=448}} | ConvertTo-Json -Compress
        }
        default { throw 'Unexpected Docker fixture call.' }
    }
}
foreach ($script:profile in @('normal','busy')) {
    foreach ($script:scenario in @('ready','delayed','exit','configuration','native-client','module-loading','oom','permission','timeout','stale-socket')) {
        $scenarioClock = [Diagnostics.Stopwatch]::StartNew()
        $script:failedCheck = 'unexpected-error'
        $script:clock = [pscustomobject]@{ Elapsed = [TimeSpan]::Zero }
        $script:delays = 0
        $script:polls=0
        $message=''
        try {
            Wait-MysqlFixtureWorker -Container 'fixture-worker' -DeadlineSeconds 1 `
                -StartClock { $script:clock } -PollDelay {
                    $script:delays++
                    $script:clock.Elapsed += [TimeSpan]::FromMilliseconds(250)
                }
        }
        catch { $message=$_.Exception.Message }
        if ($script:scenario -in @('ready','delayed')) { Assert ($message -eq '') 'valid-startup' }
        else {
            $expected = switch($script:scenario) {
                'exit' {'stage=worker-process; status=exited; exit=1'}
                'oom' {'oom=True'}
                'permission' {'stage=ipc-directory'}
                'timeout' {'stage=socket-timeout'}
                'stale-socket' {'stage=ready-signal-timeout'}
                default {"stage=$script:scenario"}
            }
            Assert ($message.Contains($expected)) 'expected-category'
            Assert (-not ($message -match 'synthetic-private|synthetic-password')) 'safe-diagnostic'
        }
        $expectedPolls = switch ($script:scenario) { 'delayed' {3}; {$_ -in @('timeout','stale-socket')} {4}; default {1} }
        $expectedDelays = switch ($script:scenario) { 'delayed' {2}; {$_ -in @('timeout','stale-socket')} {4}; default {0} }
        Assert ($script:polls -eq $expectedPolls) 'poll-count'
        Assert ($script:delays -eq $expectedDelays) 'delay-count'
        Assert ($script:clock.Elapsed.TotalMilliseconds -eq $expectedDelays * 250) 'virtual-time'
        if ($script:scenario -in @('timeout','stale-socket')) { Assert ($message.Contains('deadline-seconds=1')) 'deadline' }
        Write-Output "READINESS scenario=$script:scenario profile=$script:profile polls=$script:polls delays=$script:delays virtual-ms=$($script:clock.Elapsed.TotalMilliseconds) wall-ms=$($scenarioClock.ElapsedMilliseconds)"
    }
}
Write-Output 'PASS bounded worker startup diagnostics: ready, delayed, early exit, configuration, native client, module load, OOM, IPC ownership, timeout and stale socket.'
