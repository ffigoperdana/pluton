param(
    [ValidateSet('small','proxy','history','medium','large','four','metadata','colon','percent','symlink','fifo')]
    [string[]]$Modes=@('small','proxy','history','medium','large','four','metadata','colon','percent','symlink','fifo'),
    [string]$Image='pluton-phase5-real-db:local',
    [switch]$Baseline,
    [switch]$PackagedRuntime,
    [string]$BaselineRef='origin/main'
)
# Task-owned isolated Linux containers only. No production input, host network,
# published port, Docker socket, user data mount or global Docker/WSL change.
$ErrorActionPreference='Stop'
if($PackagedRuntime -and $Baseline){throw 'Packaged runtime validation cannot overlay baseline source.'}
if($PackagedRuntime -and -not $PSBoundParameters.ContainsKey('Image')){$Image='pluton-managed-download-reliability:local'}
$labUid=if($PackagedRuntime){10001}else{1000}
$labRepo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$labId=[Guid]::NewGuid().ToString('N')
$labVolume="pluton-download-lab-$labId"
$labContainer="pluton-download-lab-$labId"
$labScratch=Join-Path $labRepo "tmp/managed-download-lab-$labId"
$volumeCreated=$false
$containerStarted=$false
try {
    if($PackagedRuntime){& node (Join-Path $labRepo 'scripts/build-managed-recovery-lab.mjs');if($LASTEXITCODE -ne 0){throw 'Could not build packaged runtime fixture.'}}
    $hostDisk=Get-PSDrive -Name ([IO.Path]::GetPathRoot($labRepo).Substring(0,1))
    if($hostDisk.Free -lt 32GB){throw 'At least 32 GiB free host disk space is required.'}
    if($Baseline){
        $revision=& git -C $labRepo rev-parse --verify --end-of-options "$BaselineRef`^{commit}"
        if($LASTEXITCODE -ne 0 -or $revision -notmatch '^[a-f0-9]{40}$'){throw 'Baseline must resolve to a local commit.'}
        foreach($file in @('utils/restic/ManagedSnapshotIndex.ts','utils/restic/ManagedSftpRepositorySession.ts','services/RemoteRepositoryRecoveryService.ts','controllers/BackupController.ts')){
            $target=Join-Path $labScratch $file
            New-Item -Force -ItemType Directory (Split-Path $target) | Out-Null
            $content=& git -C $labRepo show "${revision}:backend/src/$file"
            if($LASTEXITCODE -ne 0){throw 'Could not read baseline source.'}
            $content | Set-Content -LiteralPath $target -Encoding utf8
        }
    }
    & docker volume create --label pluton.disposable=managed-download-recovery $labVolume | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Could not create disposable lab volume.'}
    $volumeCreated=$true
    # Root is used once solely to initialize this new empty volume's ownership.
    & docker run --rm --network none --read-only --user 0 --mount "type=volume,source=$labVolume,target=/lab" --entrypoint chown $Image "${labUid}:${labUid}" /lab
    if($LASTEXITCODE -ne 0){throw 'Could not initialize unprivileged lab volume.'}
    foreach($mode in $Modes){
        $labArgs=@('run','--rm','--init','--name',$labContainer,'--network','none','--read-only','--user',"${labUid}:${labUid}",
            '--cpus','2','--memory','4g','--memory-swap','4g','--pids-limit','192',
            '--tmpfs','/tmp:rw,exec,nosuid,nodev,size=128m',
            '--tmpfs',"/data:rw,noexec,nosuid,nodev,uid=$labUid,gid=$labUid,mode=700,size=64m",
            '--mount',"type=volume,source=$labVolume,target=/lab",'-e','NODE_ENV=test','-e','PLUTON_DATA_DIR=/data',
            '-e',"ENCRYPTION_KEY=$([Guid]::NewGuid().ToString('N'))",'-e','USER_NAME=fixture-admin',
            '-e',"USER_PASSWORD=$([Guid]::NewGuid().ToString('N'))")
        if(-not $PackagedRuntime){foreach($dir in @('src','__tests__')){$labArgs+=@('--mount',"type=bind,source=$labRepo/backend/$dir,target=/app/backend/$dir,readonly")}}
        if($mode -in @('symlink','fifo')){$labArgs+=@('-e','LAB_EXPECT_REFUSAL=1')}
        if($Baseline){
            $labArgs+=@('-e','LAB_BASELINE=1','-e','LAB_EXPECT_REFUSAL=1')
            foreach($file in @('utils/restic/ManagedSnapshotIndex.ts','utils/restic/ManagedSftpRepositorySession.ts','services/RemoteRepositoryRecoveryService.ts','controllers/BackupController.ts')){
                $labArgs+=@('--mount',"type=bind,source=$labScratch/$file,target=/app/backend/src/$file,readonly")
            }
        }
        if($PackagedRuntime){$labArgs+=@('--mount',"type=bind,source=$labRepo/tmp/managed-recovery-runtime-fixture,target=/app/backend/fixture-code,readonly",'--entrypoint','node',$Image,'--loader','./backend/loader.mjs','/app/backend/fixture-code/managedDownloadRecovery.lab.mjs',$mode)}
        else{$labArgs+=@('--entrypoint','/app/backend/node_modules/.bin/tsx',$Image,'/app/backend/__tests__/integration/managedDownloadRecovery.lab.ts',$mode)}
        $containerStarted=$true
        $output=@(& docker @labArgs)
        $labExit=$LASTEXITCODE
        $output | Write-Output
        if($labExit -ne 0){throw "Disposable lab failed: $mode"}
        # An empty/accidentally missing harness must never count as acceptance.
        $records=@($output | Where-Object {$_ -match '^\{"event":"managed_recovery_lab"'} | ForEach-Object {$_ | ConvertFrom-Json})
        $cleanup=@($output | Where-Object {$_ -match '^\{"event":"managed_recovery_lab_cleanup"'} | ForEach-Object {$_ | ConvertFrom-Json})
        if($records.Count -ne 1 -or $records[0].fixture -ne $mode -or $cleanup.Count -ne 1 -or -not $cleanup[0].removed -or $cleanup[0].activeSessions -ne 0){throw "Incomplete lab evidence: $mode"}
        if(-not $Baseline -and $mode -eq 'small' -and $records[0].sftpDisconnect -ne 'PASS'){throw 'SFTP stream failure propagation was not verified.'}
        if(-not $Baseline -and $mode -notin @('symlink','fifo') -and $records[0].download -ne 'PASS'){throw "Download acceptance missing: $mode"}
        $containerStarted=$false
    }
} finally {
    # Generated exact names only; no wildcard deletion, unrelated containers or volumes.
    if($labContainer -notmatch '^pluton-download-lab-[a-f0-9]{32}$' -or $labVolume -notmatch '^pluton-download-lab-[a-f0-9]{32}$'){throw 'Unsafe lab cleanup identity.'}
    if($containerStarted){& docker rm --force $labContainer 2>$null | Out-Null}
    if($volumeCreated){& docker volume rm $labVolume | Out-Null;if($LASTEXITCODE -ne 0){throw 'Disposable lab volume cleanup failed.'}}
    if(Test-Path -LiteralPath $labScratch){
        $resolved=[IO.Path]::GetFullPath($labScratch)
        $expectedRoot=[IO.Path]::GetFullPath((Join-Path $labRepo 'tmp'))
        if([IO.Path]::GetDirectoryName($resolved) -ne $expectedRoot -or [IO.Path]::GetFileName($resolved) -notmatch '^managed-download-lab-[a-f0-9]{32}$'){throw 'Unsafe baseline scratch cleanup path.'}
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
