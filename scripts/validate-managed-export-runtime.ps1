param([string]$Image='pluton-resumable-native:local')
# Current compiled artifacts with Linux dependencies. Not a production-image build.
# Network-none, no real credentials, ports, host data volume or Docker socket.
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$name='pluton-export-runtime-'+[Guid]::NewGuid().ToString('N')
try {
    $arguments=@('run','--rm','--name',$name,'--network','none','--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges:true','--cpus','2','--memory','4g','--memory-swap','4g','--pids-limit','192','--tmpfs','/data:rw,noexec,nosuid,nodev,size=128m,uid=10001,gid=10001,mode=700','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=700')
    foreach($relative in @('backend/dist','backend/public','backend/drizzle','backend/loader.mjs','backend/__tests__')){
        $arguments+=@('--mount',"type=bind,source=$repo/$relative,target=/app/$relative,readonly")
    }
    $arguments+=@('-e','PLUTON_EXPORT_RUNTIME_FIXTURE=1','-e','IS_DOCKER=true','-w','/app/backend','--entrypoint','node',$Image,'--loader','/app/backend/loader.mjs','--import','tsx','/app/backend/__tests__/integration/managedExportRuntime.smoke.ts')
    & docker @arguments
    if($LASTEXITCODE -ne 0){throw 'Disposable compiled export runtime checks failed.'}
} finally {
    if($name -notmatch '^pluton-export-runtime-[a-f0-9]{32}$'){throw 'Unsafe disposable runtime identity.'}
    & docker rm -f $name 2>$null | Out-Null
}
