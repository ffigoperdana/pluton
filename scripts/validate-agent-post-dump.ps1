param([switch]$Baseline,[string]$AgentDist,[string]$RuntimeImage='pluton-agent-post-dump:local',[string]$DatabaseImage='mysql@sha256:24989179f58856db763f418010c1169fecc944e3ec1ea7e921572d83eb070f70')
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if($Baseline -and -not $AgentDist){throw 'Baseline mode requires an independently compiled original AgentDist; it must not use the patched build.'}
Push-Location $repo
try {
    if(-not $AgentDist){
        pnpm --filter @plutonhq/pluton-agent build
        if($LASTEXITCODE -ne 0){throw 'Agent fixture compilation failed.'}
        $AgentDist=Join-Path $repo 'agent/dist'
    }
    $AgentDist=(Resolve-Path -LiteralPath $AgentDist).Path
    pnpm --filter @plutonhq/core-backend exec esbuild __tests__/integration/agentPostDump.lab.ts --bundle --platform=node --format=esm --packages=external '--external:../../../agent/dist/*' --outfile=../tmp/agent-post-dump/fixture.mjs
    if($LASTEXITCODE -ne 0){throw 'Native fixture compilation failed.'}
} finally {Pop-Location}
$id=[Guid]::NewGuid().ToString('N');$network="pluton-post-dump-$id";$database="$network-db";$runner="$network-agent"
$password=[Guid]::NewGuid().ToString('N')
try {
    docker network create --internal $network | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Disposable network unavailable.'}
    docker run -d --rm --name $database --network $network --network-alias fixture-db --memory 768m --memory-swap 768m --pids-limit 128 --tmpfs /var/lib/mysql:rw,nosuid,nodev,size=512m -e "MYSQL_ROOT_PASSWORD=$password" -e 'MYSQL_ROOT_HOST=%' $DatabaseImage | Out-Null
    if($LASTEXITCODE -ne 0){throw 'Disposable MySQL unavailable.'}
    $arguments=@('run','--rm','--init','--name',$runner,'--network',"container:$database",'--read-only','--user','10001:10001','--cpus','2','--memory','3g','--memory-swap','3g','--pids-limit','192','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,exec,nosuid,nodev,size=512m','--tmpfs','/data:rw,nosuid,nodev,uid=10001,gid=10001,mode=700,size=32m','--mount',"type=bind,source=$AgentDist,target=/app/agent/dist,readonly",'--mount',"type=bind,source=$repo/agent/package.json,target=/app/agent/package.json,readonly",'--mount',"type=bind,source=$repo/tmp/agent-post-dump/fixture.mjs,target=/app/backend/__tests__/integration/fixture.mjs,readonly",'--mount',"type=bind,source=$repo/backend/__tests__/integration/agentPostDump.restart.mjs,target=/app/backend/__tests__/integration/agentPostDump.restart.mjs,readonly",'-e',"FIXTURE_MYSQL_PASSWORD=$password",'--entrypoint','node',$RuntimeImage,'/app/backend/__tests__/integration/fixture.mjs')
    if($Baseline){$arguments+='--baseline'}
    & docker @arguments
    if($LASTEXITCODE -ne 0){throw 'Disposable post-dump fixture failed.'}
} finally {
    if($runner -notmatch '^pluton-post-dump-[a-f0-9]{32}-agent$' -or $database -ne "$network-db"){throw 'Unsafe fixture identity.'}
    docker rm -f $runner $database 2>$null | Out-Null
    docker network rm $network | Out-Null
}
