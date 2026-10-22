param(
    [Parameter(Mandatory = $true)][string]$AgentCheckout,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{40}$')][string]$AgentCommit
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$checkout = (Resolve-Path -LiteralPath $AgentCheckout).Path
$actual = & git -C $checkout rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $actual -ne $AgentCommit) { throw 'Standalone checkout must match the separately reviewed full SHA.' }
$dirty = & git -C $checkout status --porcelain --untracked-files=all
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Standalone checkout must be clean; no private or generated files are copied.' }
$id = [Guid]::NewGuid().ToString('N')
$context = Join-Path $project "tmp/agent-enrollment-$id"
$image = "pluton-agent-enrollment-test:$id"
New-Item -ItemType Directory -Path $context | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot '__tests__/agent-enrollment/*') -Destination $context
# Read-only Git export: no mutation or dependency installation in the Agent repository.
& git -C $checkout bundle create (Join-Path $context 'agent.bundle') HEAD
if ($LASTEXITCODE -ne 0) { throw 'Standalone Git bundle export failed.' }
& node --experimental-strip-types (Join-Path $PSScriptRoot '__tests__/agent-enrollment/generate.mjs') $AgentCommit $context
if ($LASTEXITCODE -ne 0) { throw 'Command generation failed.' }
try {
    & docker build --progress=plain --tag $image $context
    if ($LASTEXITCODE -ne 0) { throw "Disposable Ubuntu validation failed. Context retained privately: $context" }
    Write-Output 'PASS generated standalone Ubuntu enrollment; see the explicit systemd/production limitations in test output.'
} finally {
    & docker image inspect $image *> $null
    if ($LASTEXITCODE -eq 0) { & docker image rm $image | Out-Null }
}
