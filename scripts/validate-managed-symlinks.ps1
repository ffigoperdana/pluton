param([ValidateSet('small','large','combined','four')][string[]]$Modes=@('small','large','combined','four'),[string]$Image='pluton-symlink-native:local')
# All generated objects belong to this invocation; no published ports, host data,
# Docker socket, production repository inputs or global Docker/WSL changes.
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$id=[Guid]::NewGuid().ToString('N')
$container="pluton-symlink-fixture-$id"
$volume="$container-data"
$created=$false
try {
    & docker volume create --label pluton.disposable=managed-symlinks $volume | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Could not create disposable fixture volume.'}
    $created=$true
    & docker run --rm --network none --read-only --user 0 --mount "type=volume,source=$volume,target=/lab" --entrypoint chown $Image '1000:1000' /lab
    if($LASTEXITCODE -ne 0){throw 'Could not initialize private fixture ownership.'}
    foreach($mode in $Modes){
        $arguments=@('run','--rm','--init','--name',$container,'--network','none','--read-only','--user','1000:1000',
            '--cpus','2','--memory','4g','--memory-swap','4g','--pids-limit','192','--cap-drop','ALL','--security-opt','no-new-privileges:true',
            '--tmpfs','/tmp:rw,exec,nosuid,nodev,uid=1000,gid=1000,size=128m',
            '--tmpfs','/data:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=700,size=64m',
            '--mount',"type=volume,source=$volume,target=/lab",'--mount',"type=bind,source=$repo/backend/src,target=/app/backend/src,readonly",
            '--mount',"type=bind,source=$repo/backend/__tests__,target=/app/backend/__tests__,readonly",'-e','NODE_ENV=test','-e','PLUTON_DATA_DIR=/data',
            '-e',"ENCRYPTION_KEY=$([Guid]::NewGuid().ToString('N'))",'-e','USER_NAME=fixture-admin','-e',"USER_PASSWORD=$([Guid]::NewGuid().ToString('N'))",
            '--entrypoint','/app/backend/node_modules/.bin/tsx',$Image,'/app/backend/__tests__/integration/managedSymlinkRecovery.lab.ts',$mode)
        $output=@(& docker @arguments)
        $code=$LASTEXITCODE
        $output | Write-Output
        if($code -ne 0){throw "Disposable symlink fixture failed: $mode"}
        $records=@($output | Where-Object {$_ -match '^\{"event":"managed_symlink_lab"'} | ForEach-Object {$_ | ConvertFrom-Json})
        $cleanup=@($output | Where-Object {$_ -match '^\{"event":"managed_symlink_lab_cleanup"'} | ForEach-Object {$_ | ConvertFrom-Json})
        if($records.Count -ne 1 -or $records[0].fixture -ne $mode -or $records[0].fullDownload -ne 'PASS' -or $records[0].regularFilesOnly -ne 'PASS' -or $records[0].fullRestore -ne 'PASS' -or $cleanup.Count -ne 1 -or -not $cleanup[0].removed){throw 'Incomplete symlink fixture evidence.'}
    }
} finally {
    if($container -notmatch '^pluton-symlink-fixture-[a-f0-9]{32}$' -or $volume -ne "$container-data"){throw 'Unsafe fixture cleanup identity.'}
    & docker rm -f $container 2>$null | Out-Null
    if($created){& docker volume rm $volume | Out-Null;if($LASTEXITCODE -ne 0){throw 'Disposable symlink volume cleanup failed.'}}
}
