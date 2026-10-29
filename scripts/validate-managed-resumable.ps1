param([ValidateSet('small','large','combined','four','metadata')][string[]]$Modes=@('small','large','combined','four','metadata'),[string]$Image='pluton-resumable-native:local',[switch]$ProductionCompose,[switch]$SharedNamespace,[switch]$WriteOnceReference)
# Every resource belongs to this invocation. No published ports, production
# storage inputs, Docker socket mount, global settings or application deployment.
$ErrorActionPreference='Stop'
if($WriteOnceReference -and -not $SharedNamespace){throw 'The write-once reference requires explicit shared-namespace isolation.'}
# Each dataset needs its own native bucket/repositories. Reusing a prior mode's
# storage would mix historical replica manifests and is not an isolated test.
if($Modes.Count -gt 1){
    foreach($mode in $Modes){& $PSCommandPath -Modes $mode -Image $Image -ProductionCompose:$ProductionCompose -SharedNamespace:$SharedNamespace -WriteOnceReference:$WriteOnceReference}
    return
}
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$id=[Guid]::NewGuid().ToString('N')
$name="pluton-resumable-fixture-$id"
$network="$name-network";$lab="$name-lab";$storage="$name-storage";$minio="$name-s3"
$saved=@{}
$names=@('FIXTURE_ADMIN_ACCESS','FIXTURE_ADMIN_SECRET','PLUTON_WRITE_ONCE_REFERENCE','MANAGED_EXPORT_ENABLED','MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE','MANAGED_EXPORT_ENDPOINT','MANAGED_EXPORT_REGION','MANAGED_EXPORT_BUCKET','MANAGED_EXPORT_PREFIX','MANAGED_EXPORT_ACCESS_KEY_ID','MANAGED_EXPORT_SECRET_ACCESS_KEY','MANAGED_EXPORT_SESSION_TOKEN','MANAGED_EXPORT_CA_FILE','MANAGED_EXPORT_TTL_SECONDS','MANAGED_EXPORT_CA_HOST_FILE','PLUTON_IMAGE_REF','PLUTON_VOLUME_NAME','ENCRYPTION_KEY','USER_NAME','USER_PASSWORD','NODE_ENV','PLUTON_DATA_DIR')
foreach($key in $names){$saved[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
$createdNetwork=$false;$createdLab=$false;$createdStorage=$false
$private=Join-Path $repo "tmp/$name";$appData="$name-app-data";$createdAppData=$false
try {
    & docker network create --internal --label pluton.disposable=managed-resumable $network | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Disposable network creation failed.'};$createdNetwork=$true
    & docker volume create --label pluton.disposable=managed-resumable $lab | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Disposable client volume creation failed.'};$createdLab=$true
    & docker volume create --label pluton.disposable=managed-resumable $storage | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Disposable S3 volume creation failed.'};$createdStorage=$true
    & docker run --rm --network none --read-only --user 0 --mount "type=volume,source=$lab,target=/lab" --mount "type=volume,source=$storage,target=/storage" --entrypoint sh $Image -c 'mkdir -p /lab/tls; openssl req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout /lab/tls/private.key -out /lab/tls/public.crt -subj /CN=minio -addext subjectAltName=DNS:minio,IP:127.0.0.1 >/dev/null 2>&1 && chown -R 1000:1000 /lab /storage && chmod 700 /lab /storage /lab/tls && chmod 600 /lab/tls/private.key'
    if($LASTEXITCODE -ne 0){throw 'Disposable TLS/volume initialization failed.'}
    $env:FIXTURE_ADMIN_ACCESS=[Guid]::NewGuid().ToString('N');$env:FIXTURE_ADMIN_SECRET=[Guid]::NewGuid().ToString('N')
    $env:PLUTON_WRITE_ONCE_REFERENCE=if($WriteOnceReference){'true'}else{'false'}
    $env:MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE=if($SharedNamespace){'true'}else{'false'};$env:MANAGED_EXPORT_ENABLED='true';$env:MANAGED_EXPORT_ENDPOINT='https://minio:9000';$env:MANAGED_EXPORT_BUCKET='example-private-exports'
    $env:MANAGED_EXPORT_ACCESS_KEY_ID=[Guid]::NewGuid().ToString('N');$env:MANAGED_EXPORT_SECRET_ACCESS_KEY=[Guid]::NewGuid().ToString('N');$env:MANAGED_EXPORT_CA_FILE='/lab/tls/public.crt'
    $env:MANAGED_EXPORT_REGION='us-east-1';$env:MANAGED_EXPORT_PREFIX='pluton-temporary-exports';$env:MANAGED_EXPORT_SESSION_TOKEN='';$env:MANAGED_EXPORT_TTL_SECONDS='7200'
    $env:ENCRYPTION_KEY=[Guid]::NewGuid().ToString('N');$env:USER_NAME='fixture-admin';$env:USER_PASSWORD=[Guid]::NewGuid().ToString('N');$env:NODE_ENV='test';$env:PLUTON_DATA_DIR='/data'
    $minioEnvironment=@("MINIO_ROOT_USER=$env:FIXTURE_ADMIN_ACCESS","MINIO_ROOT_PASSWORD=$env:FIXTURE_ADMIN_SECRET","MINIO_KMS_SECRET_KEY=fixture:$([Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))")
    $minioArguments=@('run','-d','--name',$minio,'--network',$network,'--network-alias','minio','--read-only','--user','1000:1000','--cpus','1','--memory','1g','--memory-swap','1g','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges:true','--mount',"type=volume,source=$lab,target=/lab,readonly",'--mount',"type=volume,source=$storage,target=/storage",'--tmpfs','/tmp:rw,noexec,nosuid,nodev,uid=1000,gid=1000,size=32m')
    foreach($entry in $minioEnvironment){$minioArguments+=@('-e',$entry)}
    $minioArguments+=@('minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e','server','/storage','--address',':9000','--console-address',':9001','--certs-dir','/lab/tls')
    & docker @minioArguments | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Disposable encrypted S3 server startup failed.'}
    if($ProductionCompose){
        New-Item -ItemType Directory -Force -Path $private | Out-Null
        & docker cp "${minio}:/lab/tls/public.crt" (Join-Path $private 'ca.pem')
        if($LASTEXITCODE -ne 0){throw 'Disposable public CA copy failed.'}
        # A Linux-owned source retains real 0644 metadata under Docker Desktop;
        # NTFS bind files may appear 0777 and are correctly refused by the app.
        $certificateRoot=(& docker volume inspect $lab --format '{{.Mountpoint}}').Trim()
        if($certificateRoot -notmatch '^/var/lib/docker/volumes/pluton-resumable-fixture-[a-f0-9]{32}-lab/_data$'){throw 'Unexpected disposable certificate source.'}
        $env:MANAGED_EXPORT_CA_HOST_FILE="$certificateRoot/tls/public.crt"
        $env:MANAGED_EXPORT_CA_FILE='/run/secrets/pluton-managed-export-ca.pem'
        $env:PLUTON_IMAGE_REF=$Image;$env:PLUTON_VOLUME_NAME=$appData
        & docker volume create --label pluton.disposable=managed-resumable $appData | Out-Null
        if($LASTEXITCODE -ne 0){throw 'Disposable application data volume failed.'};$createdAppData=$true
        & docker run --rm --network none --read-only --user 0 --mount "type=volume,source=$appData,target=/data" --entrypoint chown $Image '-R' '1000:1000' /data
        if($LASTEXITCODE -ne 0){throw 'Disposable application data ownership failed.'}
        $privateEnv=@($names | ForEach-Object {"$_=$([Environment]::GetEnvironmentVariable($_,'Process'))"}) -join "`n"
        [IO.File]::WriteAllText((Join-Path $private '.env'),$privateEnv)
        $mounts=@(@{type='volume';source='lab';target='/lab'})
        foreach($relative in @('backend/src','backend/__tests__')){$mounts+=@{type='bind';source="$repo/$relative".Replace('\','/');target="/app/$relative";read_only=$true}}
        $override=@{services=@{pluton=@{user='1000:1000';restart='no';cpus=2;mem_limit='4g';memswap_limit='4g';pids_limit=192;volumes=$mounts;environment=@{NODE_ENV='test';PLUTON_WRITE_ONCE_REFERENCE=$env:PLUTON_WRITE_ONCE_REFERENCE;FIXTURE_ADMIN_ACCESS=$env:FIXTURE_ADMIN_ACCESS;FIXTURE_ADMIN_SECRET=$env:FIXTURE_ADMIN_SECRET}}};volumes=@{lab=@{external=$true;name=$lab}};networks=@{default=@{external=$true;name=$network}}}
        [IO.File]::WriteAllText((Join-Path $private 'compose.fixture.json'),($override | ConvertTo-Json -Depth 12))
    }
    foreach($mode in $Modes){
        $arguments=@('run','--rm','--init','--name',$name,'--network',$network,'--read-only','--user','1000:1000','--cpus','2','--memory','4g','--memory-swap','4g','--pids-limit','192','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,exec,nosuid,nodev,uid=1000,gid=1000,size=128m','--tmpfs','/data:rw,noexec,nosuid,nodev,uid=1000,gid=1000,mode=700,size=64m','--mount',"type=volume,source=$lab,target=/lab",'--mount',"type=bind,source=$repo/backend/src,target=/app/backend/src,readonly",'--mount',"type=bind,source=$repo/backend/__tests__,target=/app/backend/__tests__,readonly")
        foreach($key in $names){$arguments+=@('-e',$key)}
        $arguments+=@('--entrypoint','/app/backend/node_modules/.bin/tsx',$Image,'/app/backend/__tests__/integration/managedResumableRecovery.lab.ts',$mode)
        if($ProductionCompose){$arguments=@('compose','--project-name',$name,'--env-file',(Join-Path $private '.env'),'-f',(Join-Path $repo 'deploy/compose.yml'),'-f',(Join-Path $repo 'deploy/compose.managed-export-ca.yml'),'-f',(Join-Path $private 'compose.fixture.json'),'run','--rm','--no-deps','--name',$name,'--entrypoint','/app/backend/node_modules/.bin/tsx','pluton','/app/backend/__tests__/integration/managedResumableRecovery.lab.ts',$mode)}
        $output=[Collections.Generic.List[string]]::new()
        & docker @arguments | ForEach-Object {$output.Add([string]$_);Write-Output $_}
        $code=$LASTEXITCODE
        if($code -ne 0){throw "Disposable resumable fixture failed: $mode"}
        $records=@($output | Where-Object {$_ -match '^\{"event":"managed_resumable_lab"'} | ForEach-Object {$_ | ConvertFrom-Json})
        $cleanup=@($output | Where-Object {$_ -match '^\{"event":"managed_resumable_cleanup"'} | ForEach-Object {$_ | ConvertFrom-Json})
        if($records.Count -ne 1 -or $records[0].integrity -ne 'PASS' -or $records[0].httpRangeResume -ne 'PASS' -or $cleanup.Count -ne 1 -or -not $cleanup[0].removed){throw 'Incomplete resumable fixture evidence.'}
    }
} finally {
    foreach($resource in @($name,$network,$lab,$storage,$minio,$appData)){if($resource -notmatch '^pluton-resumable-fixture-[a-f0-9]{32}(?:-network|-lab|-storage|-s3|-app-data)?$'){throw 'Unsafe disposable resource identity.'}}
    & docker rm -f $name $minio 2>$null | Out-Null
    if($createdLab){& docker volume rm $lab | Out-Null}
    if($createdStorage){& docker volume rm $storage | Out-Null}
    if($createdNetwork){& docker network rm $network | Out-Null}
    if($createdAppData){& docker volume rm $appData | Out-Null}
    if(Test-Path -LiteralPath $private){$resolved=(Resolve-Path -LiteralPath $private).Path;$expected=Join-Path (Join-Path $repo 'tmp') $name;if($resolved -ne $expected){throw 'Unsafe private fixture directory.'};Remove-Item -LiteralPath $resolved -Recurse -Force}
    foreach($key in $names){[Environment]::SetEnvironmentVariable($key,$saved[$key],'Process')}
}
