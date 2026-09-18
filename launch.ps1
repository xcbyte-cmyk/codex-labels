param(
    [switch]$CheckOnly,
    [switch]$RegisterNotifications,
    [switch]$UnregisterNotifications
)
$ErrorActionPreference = 'Stop'
$labelRoot = $PSScriptRoot
trap {
    [pscustomobject]@{ version=3; status='failed'; updatedAt=(Get-Date).ToString('o'); message=$_.Exception.Message } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $labelRoot 'launch-status.json') -Encoding UTF8
    Write-Error $_ -ErrorAction Continue
    exit 1
}
if ($RegisterNotifications -and $UnregisterNotifications) { throw '등록과 해제는 동시에 요청할 수 없습니다.' }
if (-not $CheckOnly -and -not $RegisterNotifications -and -not $UnregisterNotifications) {
    $helperPath = Join-Path $labelRoot 'CodexLabelsHelper.exe'
    if (Test-Path -LiteralPath $helperPath) { & $helperPath launch }
    else { & python (Join-Path $labelRoot 'windows_helper.py') launch }
    exit $LASTEXITCODE
}
$labelApp = Join-Path $labelRoot 'runtime/app/ChatGPT.exe'
if (-not (Test-Path -LiteralPath $labelApp)) { throw '먼저 prepare_runtime.py를 실행해 앱 사본을 준비하세요.' }
$receiptPath = Join-Path $labelRoot 'runtime/app/codex-labels-build.json'
if (-not (Test-Path -LiteralPath $receiptPath)) { throw '이 런타임은 이전 빌드입니다. Labels를 닫고 기존 runtime/app을 백업한 뒤 다시 준비하세요.' }
$receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($receipt.version -ne 3) { throw '지원하지 않는 Labels 런타임입니다. 현재 소스로 다시 빌드하세요.' }
$labelProfile = Join-Path $env:LOCALAPPDATA 'CodexLabels/User Data'
$labelStatus = Join-Path $labelRoot 'runtime-status.json'
if ($CheckOnly) {
    [pscustomobject]@{ Ready=$true; RuntimeVersion=$receipt.version; App=$labelApp; Profile=$labelProfile; OriginalAppMayRemainOpen=$true
        NotificationRegistrationRequested=[bool]$RegisterNotifications; RuntimeStatus=$labelStatus } | ConvertTo-Json
    exit 0
}
New-Item -ItemType Directory -Path $labelProfile -Force | Out-Null
$labelStart = New-Object System.Diagnostics.ProcessStartInfo
$labelStart.FileName = $labelApp
$labelStart.WorkingDirectory = Split-Path -Parent $labelApp
$labelStart.UseShellExecute = $false
$labelStart.CreateNoWindow = $true
$labelStart.Arguments = '--user-data-dir="' + $labelProfile + '"'
if ($RegisterNotifications) { $labelStart.Arguments += ' --codex-labels-register-notifications' }
if ($UnregisterNotifications) { $labelStart.Arguments += ' --codex-labels-unregister-notifications' }
$labelStart.EnvironmentVariables['CODEX_ELECTRON_USER_DATA_PATH'] = $labelProfile
$labelStart.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
$labelProcess = [System.Diagnostics.Process]::Start($labelStart)
[pscustomobject]@{
    version=3; status='launch-requested'; launchedAt=(Get-Date).ToString('o')
    processId=$labelProcess.Id; profile=$labelProfile; executable=$labelApp
    originalAppStopped=$false; runtimeStatus=$labelStatus
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $labelRoot 'launch-status.json') -Encoding UTF8
Write-Output 'Codex Labels 실행을 요청했습니다. 알림 등록 및 실제 기동 결과는 runtime-status.json에서 확인하세요.'
