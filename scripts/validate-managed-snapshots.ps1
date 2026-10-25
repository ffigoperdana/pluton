param(
    [ValidateSet('load', 'small', 'large')][string[]]$Modes = @('load', 'small', 'large'),
    [string]$Image = 'pluton-phase5-real-db:local'
)
# Disposable fixtures only. No host data/config/credentials, published port or host network.
$snapshotRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
foreach ($mode in $Modes) {
    $cases = if ($mode -eq 'load') { @(22, 5000, 100000) } else { @($mode) }
    foreach ($case in $cases) {
        $snapshotArgs = @('run','--rm','--init','--network','none','--read-only','--user','node','--memory','2g',
            '--tmpfs','/tmp:rw,exec,nosuid,nodev,size=1536m',
            '--tmpfs','/data:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=700,size=64m',
            '-e','NODE_ENV=test','-e','PLUTON_DATA_DIR=/data',
            '-e',"ENCRYPTION_KEY=$([Guid]::NewGuid().ToString('N'))",'-e','USER_NAME=fixture-admin',
            '-e',"USER_PASSWORD=$([Guid]::NewGuid().ToString('N'))")
        foreach ($directory in @('src','__tests__')) {
            $source = Join-Path $snapshotRepoRoot "backend/$directory"
            $snapshotArgs += @('--mount',"type=bind,source=$source,target=/app/backend/$directory,readonly")
        }
        if ($mode -eq 'load') { $snapshotArgs += @('-e','NODE_OPTIONS=--max-old-space-size=128') }
        $snapshotArgs += @('--entrypoint','/app/backend/node_modules/.bin/tsx',$Image)
        if ($mode -eq 'load') { $snapshotArgs += @('/app/backend/__tests__/integration/managedSnapshotIndex.load.ts',"$case") }
        elseif ($mode -eq 'small') { $snapshotArgs += '/app/backend/__tests__/integration/managedSftpRecovery.smoke.ts' }
        else { $snapshotArgs += '/app/backend/__tests__/integration/managedSnapshotStreaming.smoke.ts' }
        & docker @snapshotArgs
        if ($LASTEXITCODE -ne 0) { throw "Disposable managed snapshot validation failed: $mode/$case" }
    }
}
