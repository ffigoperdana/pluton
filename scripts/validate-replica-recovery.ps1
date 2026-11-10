param([string]$Image='pluton-replica-recovery:local', [string]$OpenSsl='C:\Program Files\Git\usr\bin\openssl.exe')
$ErrorActionPreference='Stop'
& python (Join-Path $PSScriptRoot 'validate-replica-recovery.py') $Image --openssl $OpenSsl
if($LASTEXITCODE -ne 0){throw 'Disposable replica recovery failed.'}
