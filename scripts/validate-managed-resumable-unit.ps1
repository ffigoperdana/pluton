param([string]$Image='pluton-resumable-native:local')
# Complements Windows tests with Linux ownership/symlink/native-client checks.
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$name='pluton-export-unit-'+[Guid]::NewGuid().ToString('N')
$volume="$name-data";$created=$false
try {
    & docker volume create --label pluton.disposable=managed-export-unit $volume | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Disposable unit volume creation failed.'};$created=$true
    & docker run --rm --network none --read-only --user 0 --mount "type=volume,source=$volume,target=/scratch" --entrypoint chown $Image '1000:1000' /scratch
    if($LASTEXITCODE -ne 0){throw 'Disposable unit volume ownership failed.'}
    $arguments=@('run','--rm','--name',$name,'--network','none','--read-only','--user','1000:1000','--cpus','2','--memory','4g','--memory-swap','4g','--pids-limit','192','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',"type=volume,source=$volume,target=/scratch")
    foreach($relative in @('backend/src','backend/drizzle','backend/__tests__','backend/jest.config.ts','backend/tsconfig.json','scripts','agent/src')){
        $arguments+=@('--mount',"type=bind,source=$repo/$relative,target=/app/$relative,readonly")
    }
    $arguments+=@('-e','NODE_ENV=test','-e','TMPDIR=/scratch','-e','PLUTON_RECOVERY_NATIVE_FIXTURE=1','-w','/app/backend','--entrypoint','node',$Image,'node_modules/jest/bin/jest.js','--config','jest.config.ts','--runInBand','--cacheDirectory','/scratch/jest-cache',
        '__tests__/services/HcpWriteOnceStorage.test.ts','__tests__/stores/ManagedExportNamespace.test.ts','__tests__/services/StorageService.test.ts','__tests__/services/ManagedExportService.test.ts','__tests__/services/S3ExportStorage.test.ts','__tests__/services/RemoteRepositoryRecoveryService.test.ts','__tests__/utils/TransferTelemetry.test.ts','__tests__/utils/recoveryValidation.test.ts','__tests__/utils/recoveryDatabaseClients.test.ts','__tests__/managers/BaseSystemManager.test.ts')
    & docker @arguments
    if($LASTEXITCODE -ne 0){throw 'Disposable Linux export/recovery unit checks failed.'}
} finally {
    if($name -notmatch '^pluton-export-unit-[a-f0-9]{32}$' -or $volume -ne "$name-data"){throw 'Unsafe disposable unit identity.'}
    & docker rm -f $name 2>$null | Out-Null
    if($created){& docker volume rm $volume | Out-Null;if($LASTEXITCODE -ne 0){throw 'Disposable unit volume cleanup failed.'}}
}
