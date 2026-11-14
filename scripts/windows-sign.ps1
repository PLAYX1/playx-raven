# RavenVault 윈도우 코드서명 — 파일 하나를 서명하고 바로 검증한다 (2026-11-14 대표 결정: 직접 배포 설치 파일 서명).
#
# 누가 부르나
#   · Tauri bundle.windows.signCommand (release.yml 「윈도우 서명 준비」가 CI 에서만 넣는다) → 앱 exe·MSI·NSIS exe
#   · release.yml 「윈도우 포함 실행 파일 서명」 → src-tauri/vendor/ravend.exe·ipfs.exe (resources 라 Tauri 가 서명하지 않는다)
#
# 서명 수단은 바꿔 끼운다 — 환경 변수 WINDOWS_SIGN_METHOD (준비 단계가 시크릿을 보고 정한다)
#   pfx     : 인증서 파일(.pfx, base64) + 암호.               WINDOWS_PFX_PATH, WINDOWS_CERTIFICATE_PASSWORD
#   azure   : Azure Artifact Signing(옛 Trusted Signing).     WINDOWS_AZURE_DLIB, WINDOWS_AZURE_METADATA (+ AZURE_TENANT_ID·CLIENT_ID·CLIENT_SECRET)
#   command : 클라우드 HSM 도구(SSL.com eSigner, DigiCert KeyLocker 등)를 그대로 부른다.
#             WINDOWS_SIGN_COMMAND 안의 {file} 을 서명할 파일 경로로 바꿔 실행한다. 그 도구 설치는 수단이 정해진 뒤 단계를 더한다.
#
# 🔴 타임스탬프는 반드시 찍는다(인증서가 만료돼도 서명이 유효하게). WINDOWS_TIMESTAMP_URL 이 없으면 수단별 기본값.
# 🔴 서명 뒤 `signtool verify /pa` 가 실패하면 0 이 아닌 값으로 끝난다 → 빌드 실패 → 게시 작업(needs: build, if: success())이 돌지 않는다.
# 🔴 비밀값은 출력하지 않는다. 명령줄 전체를 찍지 않는다.
param([Parameter(Mandatory = $true, Position = 0)][string]$File)
$ErrorActionPreference = 'Stop'

function Find-SignTool {
  if ($env:WINDOWS_SIGNTOOL -and (Test-Path $env:WINDOWS_SIGNTOOL)) { return $env:WINDOWS_SIGNTOOL }
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $found = Get-ChildItem -Path $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $found) { throw '🔴 signtool.exe 를 찾지 못했습니다 (Windows SDK).' }
  return $found.FullName
}

if (-not (Test-Path -LiteralPath $File)) { throw "🔴 서명할 파일이 없습니다: $File" }
$method = "$env:WINDOWS_SIGN_METHOD".Trim().ToLowerInvariant()
if (-not $method -or $method -eq 'none') { throw '🔴 WINDOWS_SIGN_METHOD 가 비어 있는데 서명을 불렀습니다.' }
$signtool = Find-SignTool
$name = Split-Path -Leaf $File
$desc = 'RavenVault Desktop'
$descUrl = 'https://ravenvault.ex.erci.se/'

switch ($method) {
  'pfx' {
    if (-not $env:WINDOWS_PFX_PATH -or -not (Test-Path $env:WINDOWS_PFX_PATH)) { throw '🔴 인증서 파일이 준비되지 않았습니다.' }
    $ts = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
    $sa = @('sign', '/fd', 'sha256', '/tr', $ts, '/td', 'sha256', '/d', $desc, '/du', $descUrl, '/f', $env:WINDOWS_PFX_PATH)
    if ($env:WINDOWS_CERTIFICATE_PASSWORD) { $sa += @('/p', $env:WINDOWS_CERTIFICATE_PASSWORD) }
    & $signtool @sa $File | Out-Null
  }
  'azure' {
    foreach ($v in 'WINDOWS_AZURE_DLIB', 'WINDOWS_AZURE_METADATA') {
      if (-not (Test-Path ([Environment]::GetEnvironmentVariable($v)))) { throw "🔴 $v 가 준비되지 않았습니다." }
    }
    $ts = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.acs.microsoft.com' }
    & $signtool sign /v /fd sha256 /tr $ts /td sha256 /d $desc /du $descUrl /dlib $env:WINDOWS_AZURE_DLIB /dmdf $env:WINDOWS_AZURE_METADATA $File | Out-Null
  }
  'command' {
    if (-not $env:WINDOWS_SIGN_COMMAND -or $env:WINDOWS_SIGN_COMMAND -notmatch '\{file\}') { throw '🔴 WINDOWS_SIGN_COMMAND 에 {file} 자리가 없습니다.' }
    $cmd = $env:WINDOWS_SIGN_COMMAND.Replace('{file}', '"' + $File + '"')
    & cmd.exe /d /s /c $cmd | Out-Null
  }
  default { throw "🔴 모르는 서명 수단입니다: $method (pfx · azure · command)" }
}
if ($LASTEXITCODE -ne 0) { throw "🔴 서명 실패: $name (종료 코드 $LASTEXITCODE)" }

# 서명 직후 같은 자리에서 검증 — 타임스탬프까지 있어야 통과로 본다.
$out = & $signtool verify /pa /v $File 2>&1
if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 15 | ForEach-Object { Write-Host $_ }; throw "🔴 서명 검증 실패: $name" }
if (-not ($out -match 'timestamp|Timestamp')) { throw "🔴 타임스탬프가 없습니다: $name" }
Write-Host "✅ 서명·검증: $name"
