$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../mysql-worker-readiness.ps1')
function Assert([bool]$ok, [string]$message) { if (-not $ok) { throw $message } }
function docker {
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
foreach ($script:scenario in @('ready','delayed','exit','configuration','native-client','module-loading','oom','permission','timeout','stale-socket')) {
    $script:polls=0
    $message=''
    try { Wait-MysqlFixtureWorker -Container 'fixture-worker' -DeadlineSeconds 1 }
    catch { $message=$_.Exception.Message }
    if ($script:scenario -in @('ready','delayed')) { Assert ($message -eq '') 'Valid startup refused.' }
    else {
        $expected = switch($script:scenario) {
            'exit' {'stage=worker-process; status=exited; exit=1'}
            'oom' {'oom=True'}
            'permission' {'stage=ipc-directory'}
            'timeout' {'stage=socket-timeout'}
            'stale-socket' {'stage=ready-signal-timeout'}
            default {"stage=$script:scenario"}
        }
        Assert ($message.Contains($expected)) "Wrong closed startup category for $script:scenario."
        Assert (-not ($message -match 'synthetic-private|synthetic-password')) 'Startup diagnostic leaked raw provider output.'
        if ($script:scenario -notin @('timeout','stale-socket')) { Assert ($script:polls -eq 1) 'Irreversible startup failure was polled repeatedly.' }
    }
}
Write-Output 'PASS bounded worker startup diagnostics: ready, delayed, early exit, configuration, native client, module load, OOM, IPC ownership, timeout and stale socket.'
