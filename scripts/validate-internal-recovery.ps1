param([string]$RuntimeImage='pluton-internal-recovery:local', [string]$HelperImage='pluton-mysql-worker:local',
  [ValidateSet('mariadb','postgresql')][string[]]$Engines=@('mariadb','postgresql'), [switch]$WorkingTreeCode)
# Disposable private network only; no configurable endpoint, host port, source/repository/data volume or Docker socket.
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
# Docker receives these paths verbatim. A Windows separator embedded in a string
# is not normalized by PowerShell on Linux (including GitHub Actions runners).
$preparePath=Join-Path $repo 'backend/__tests__/integration/internalRecovery.prepare.mjs'
$operatorPath=Join-Path $repo 'deploy/internal-recovery/operator.cjs'
$bootstrapPath=Join-Path $repo 'deploy/internal-recovery/bootstrap.sh'
$smokePath=Join-Path $repo 'backend/__tests__/integration/internalRecovery.smoke.mjs'
$distPath=Join-Path $repo 'backend/dist'
foreach($fixturePath in @($preparePath,$operatorPath,$bootstrapPath,$smokePath)) {
  if(-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)){throw 'Required Internal recovery fixture file is missing.'}
}
$images=@{mariadb='mariadb:11.8.8@sha256:24e76fcec8c003a0362d0dd53f4806e7e79458d7fdeaf47437760e19496f5a9c';postgresql='postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c'}
foreach($engine in $Engines) { foreach($variant in @('normal','marker','existing','tls','restart')) {
  $scope='pluton-internal-fixture-'+[Guid]::NewGuid().ToString('N')
  $container="$scope-db"; $volumes=@{}; $created=@();$started=$false;$network=$false;$blocked=$false
  try {
    & docker network create --internal $scope | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Private fixture network failed.'};$network=$true
    foreach($name in @('public','requests','lock','private-mariadb','private-postgresql','state','boot')) {
      $volumes[$name]="$scope-$name";& docker volume create $volumes[$name] | Out-Null
      if($LASTEXITCODE -ne 0){throw 'Fixture volume failed.'};$created+=$volumes[$name]
    }
    $prep=@('run','--rm','--network','none','--read-only','--user','0:0','--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=32m',
      '--mount',"type=bind,source=$preparePath,target=/fixture-prepare.mjs,readonly",
      '--mount',"type=bind,source=$operatorPath,target=/fixture-operator.cjs,readonly",
      '--mount',"type=bind,source=$bootstrapPath,target=/fixture-bootstrap.sh,readonly")
    foreach($name in @('public','requests','lock','private-mariadb','private-postgresql','boot')) { $prep+=@('--mount',"type=volume,source=$($volumes[$name]),target=/$name") }
    & docker @prep --entrypoint node $HelperImage /fixture-prepare.mjs $engine $variant
    if($LASTEXITCODE -ne 0){throw 'Private TLS fixture preparation failed.'}
    $dataPath=if($engine -eq 'mariadb'){'/var/lib/mysql'}else{'/var/lib/postgresql'}
    $start=@('run','-d','--init','--name',$container,'--network',$scope,'--network-alias',"internal-$engine",
      '--hostname',"internal-$engine",'--user','999:999','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
      '--memory','2g','--memory-swap','2g','--cpus','1','--pids-limit','128',
      '--tmpfs',"${dataPath}:rw,noexec,nosuid,nodev,uid=999,gid=999,mode=700,size=2g",
      '--tmpfs','/tmp:rw,noexec,nosuid,nodev,uid=999,gid=999,mode=700,size=128m',
      '--mount',"type=volume,source=$($volumes['boot']),target=/opt/pluton-internal,readonly",
      '--mount',"type=volume,source=$($volumes["private-$engine"]),target=/run/pluton-internal-bootstrap,readonly",
      '--mount',"type=volume,source=$($volumes['lock']),target=/run/pluton-internal-lock",'--entrypoint','/bin/bash',$images[$engine],'/opt/pluton-internal/bootstrap.sh',$engine)
    & docker @start | Out-Null;if($LASTEXITCODE -ne 0){throw 'Disposable target start failed.'};$started=$true
    $ready=$false
    for($attempt=0;$attempt -lt 100;$attempt++) {
      $logs=& docker logs $container 2>$null
      if($logs -match 'internal-target-started'){$ready=$true;break}
      $running=& docker inspect --format '{{.State.Running}}' $container
      if($running -ne 'true'){throw "Disposable $engine startup failed; inspect its private fixture logs locally."}
      Start-Sleep -Milliseconds 300
    }
    if(-not $ready){throw 'Disposable target did not become ready.'}
    if($engine -eq 'mariadb' -and $variant -eq 'normal') {
      & docker run -d --init --name "$scope-blocked" --network none --user '999:999' --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 2g --memory-swap 2g --pids-limit 128 --cpus 1 --tmpfs '/var/lib/postgresql:rw,noexec,nosuid,nodev,uid=999,gid=999,mode=700,size=2g' --tmpfs '/tmp:rw,noexec,nosuid,nodev,uid=999,gid=999,mode=700,size=128m' --mount "type=volume,source=$($volumes['boot']),target=/opt/pluton-internal,readonly" --mount "type=volume,source=$($volumes['private-postgresql']),target=/run/pluton-internal-bootstrap,readonly" --mount "type=volume,source=$($volumes['lock']),target=/run/pluton-internal-lock" --entrypoint /bin/bash $images['postgresql'] /opt/pluton-internal/bootstrap.sh postgresql | Out-Null
      if($LASTEXITCODE -ne 0){throw 'Second-engine disposable guard fixture failed to start.'};$blocked=$true
      $exitCode=& docker wait "$scope-blocked"
      if($exitCode -ne '71'){throw 'Two internal engines were not refused.'}
      & docker rm "$scope-blocked" | Out-Null;$blocked=$false
      Write-Output 'PASS second internal engine refused before database initialization'
    }
    $inspect=(& docker inspect $container | ConvertFrom-Json)[0]
    if($inspect.HostConfig.Privileged -or $inspect.Config.User -ne '999:999' -or @($inspect.HostConfig.PortBindings.PSObject.Properties).Count -gt 0 -or
      $inspect.Mounts.Count -ne 3 -or @($inspect.HostConfig.Tmpfs.PSObject.Properties).Count -ne 2){throw 'Fixture isolation guard failed.'}
    $client=@('run','--rm','--init','--network',$scope,'--read-only','--user','10001:10001','--memory','2g','--memory-swap','2g',
      '--tmpfs','/tmp:rw,noexec,nosuid,nodev,uid=10001,gid=10001,mode=700,size=3g',
      '--tmpfs','/data:rw,noexec,nosuid,nodev,uid=10001,gid=10001,mode=700,size=16m',
      '--mount',"type=volume,source=$($volumes['public']),target=/run/pluton-internal-recovery,readonly",
      '--mount',"type=volume,source=$($volumes['requests']),target=/run/pluton-internal-requests",
      '--mount',"type=volume,source=$($volumes['state']),target=/fixture-state",'--mount',"type=bind,source=$smokePath,target=/fixture-smoke.mjs,readonly")
    if($WorkingTreeCode){$client+=@('--mount',"type=bind,source=$distPath,target=/app/backend/dist,readonly")}
    # Initialize only the disposable client lease directory; never the application's /data.
    & docker run --rm --network none --read-only --user '0:0' --mount "type=volume,source=$($volumes['state']),target=/state" --entrypoint sh $RuntimeImage -ec 'chown 10001:10001 /state && chmod 700 /state' | Out-Null
    & docker @client --entrypoint node $RuntimeImage --loader ./backend/loader.mjs /fixture-smoke.mjs $engine $variant
    if($LASTEXITCODE -ne 0){throw "Internal $engine $variant integration failed."}
    if($variant -eq 'restart') {
      & docker restart $container | Out-Null;if($LASTEXITCODE -ne 0){throw 'Fixture restart failed.'}
      Start-Sleep -Seconds 3
      & docker @client --entrypoint node $RuntimeImage --loader ./backend/loader.mjs /fixture-smoke.mjs $engine $variant reconcile
      if($LASTEXITCODE -ne 0){throw 'Durable lease reconciliation failed.'}
    }
    & docker stop --time 15 $container | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Owned disposable target stop failed; no removal receipt may be published.'}
    & docker rm $container | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Owned disposable target removal failed; no removal receipt may be published.'};$started=$false
    if($variant -in @('normal','restart')) {
      & docker @prep --entrypoint node $HelperImage /fixture-prepare.mjs $engine $variant receipt
      if($LASTEXITCODE -ne 0){throw 'Fixture removal receipt failed.'}
      & docker @client --entrypoint node $RuntimeImage --loader ./backend/loader.mjs /fixture-smoke.mjs $engine $variant receipt
      if($LASTEXITCODE -ne 0){throw 'Fixture receipt binding failed.'}
    }
  } finally {
    if($scope -notmatch '^pluton-internal-fixture-[a-f0-9]{32}$'){throw 'Unsafe fixture cleanup target.'}
    if($started){& docker rm -f $container | Out-Null}
    if($blocked){& docker rm -f "$scope-blocked" | Out-Null}
    foreach($volume in $created){if(-not $volume.StartsWith($scope+'-')){throw 'Unsafe fixture volume.'};& docker volume rm $volume | Out-Null}
    if($network){& docker network rm $scope | Out-Null}
  }
} }
