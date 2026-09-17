param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$labelRoot = $PSScriptRoot
trap {
    [pscustomobject]@{ version=2; status='failed'; updatedAt=(Get-Date).ToString('o'); message=$_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $labelRoot 'launch-status.json') -Encoding UTF8
    Write-Error $_ -ErrorAction Continue
    exit 1
}
$labelApp = Join-Path $labelRoot 'runtime/app/ChatGPT.exe'
if (-not (Test-Path -LiteralPath $labelApp)) { throw '먼저 prepare_runtime.py를 실행해 앱 사본을 준비하세요.' }
$labelProfile = Join-Path $env:LOCALAPPDATA 'CodexLabels/User Data'
$labelStatus = Join-Path $labelRoot 'runtime-status.json'
if ($CheckOnly) {
    [pscustomobject]@{ Ready = $true; App = $labelApp; Profile = $labelProfile; OriginalAppMayRemainOpen = $true } | ConvertTo-Json
    exit 0
}
New-Item -ItemType Directory -Path $labelProfile -Force | Out-Null
# Apply the profile override to this child only; keep the user's normal Codex home.
$labelStart = New-Object System.Diagnostics.ProcessStartInfo
$labelStart.FileName = $labelApp
$labelStart.WorkingDirectory = Split-Path -Parent $labelApp
$labelStart.UseShellExecute = $false
$labelStart.CreateNoWindow = $true
$labelStart.Arguments = '--user-data-dir="' + $labelProfile + '"'
$labelStart.EnvironmentVariables['CODEX_ELECTRON_USER_DATA_PATH'] = $labelProfile
$labelStart.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
$labelProcess = [System.Diagnostics.Process]::Start($labelStart)
[pscustomobject]@{
    version = 2; status = 'launch-requested'; launchedAt = (Get-Date).ToString('o')
    processId = $labelProcess.Id; profile = $labelProfile; executable = $labelApp
    originalAppStopped = $false; runtimeStatus = $labelStatus
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $labelRoot 'launch-status.json') -Encoding UTF8
Write-Output 'Codex Labels 실행을 요청했습니다. 실제 기동 상태는 runtime-status.json에 기록됩니다.'
