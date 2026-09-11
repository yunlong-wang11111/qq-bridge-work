# dsh-control.ps1 - QQ-triggered DSH control, invoked by the ELEVATED qq-bridge.
# Prints ASCII status lines only (bridge.js composes the Chinese QQ reply), so no
# codepage/encoding issues when captured over a pipe.
param([Parameter(Mandatory=$true)][ValidateSet('kill','restart','repair','web','status')][string]$Action)
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $env:USERPROFILE '.dsh-control.log'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

# Must be elevated: killing the (elevated) DSH and editing hosts both need it.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'NOT_ADMIN bridge must run elevated (use the elevated start.bat)'
  exit 3
}

function Stop-Dsh {
  # returns 'NONE', 'KILLED <pid> <name>', or 'FAIL <pid>'
  $conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return 'NONE' }
  $p = [int]$conn.OwningProcess
  $name = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
  taskkill /PID $p /T /F | Out-Null
  for ($i = 0; $i -lt 20; $i++) {
    $c = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $c) { return "KILLED $p $name" }
    Start-Sleep -Milliseconds 500
  }
  return "FAIL $p"
}

function Start-Dsh {
  # remove stale task-board lock (DSH won't boot with it), then start hidden, wait up to 15s
  Remove-Item (Join-Path $env:USERPROFILE '.dsh\task-board\ledger-v2.lock') -ErrorAction SilentlyContinue
  # capture DSH console so a freeze/crash leaves a trace (2026-09-07)
  # cmd /c internal redirect avoids Start-Process -Redirect hang in elevated+piped context
  $runLog = Join-Path $env:USERPROFILE '.dsh\dsh-run.log'
  $dshCmd = "$env:APPDATA\npm\dsh.cmd"
  $cmdLine = '/c ' + $dshCmd + ' web --host 127.0.0.1 --no-open >> "' + $runLog + '" 2>&1'
  Start-Process "$env:SystemRoot\System32\cmd.exe" -ArgumentList $cmdLine -WindowStyle Hidden
  # DSH 冷启动超过 15s（repair-dsh.ps1 等 40s）——这里对齐到 40s，避免提前判 TIMEOUT
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 500
    $web = & "$env:SystemRoot\System32\curl.exe" -sS -m 2 -o NUL -w '%{http_code}' 'http://127.0.0.1:3080' 2>$null
    if ($web -ne '000' -and $web -ne '') { return 'READY' }  # 0.1.2+: 401 也是就绪
  }
  return 'TIMEOUT'
}

switch ($Action) {
  'kill' {
    Add-Content $log "$stamp kill" -Encoding ASCII
    $r = Stop-Dsh
    Write-Host $r
    Add-Content $log "$stamp kill => $r" -Encoding ASCII
  }
  'restart' {
    Add-Content $log "$stamp restart" -Encoding ASCII
    $r = Stop-Dsh
    if ($r -like 'FAIL*') { Write-Host "RESTART_ABORTED $r"; break }
    $s = Start-Dsh
    Write-Host "RESTART $r start=$s"
    Add-Content $log "$stamp restart => $r start=$s" -Encoding ASCII
  }
  'web' {
    Add-Content $log "$stamp web" -Encoding ASCII
    # 复刻 DSH-Web.lnk：没在跑就启动，然后打开浏览器
    $conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
      $s = 'already'
    } else {
      $s = Start-Dsh
    }
    # 2026-09-08（0.1.2）：打开带当前 token 的入口；Start-Dsh 内部已等到 web 就绪，
    # 届时 token 启动行已写入 dsh-run.log。找不到时回退无 token 地址。
    $runLog = Join-Path $env:USERPROFILE '.dsh\dsh-run.log'
    $m = Select-String -Path $runLog -Pattern 'dsh web: http://127\.0\.0\.1:3080/\?token=([A-Za-z0-9_-]+)' | Select-Object -Last 1
    if ($m) { Start-Process ('http://127.0.0.1:3080/?token=' + $m.Matches[0].Groups[1].Value) }
    else { Start-Process 'http://127.0.0.1:3080' }
    Write-Host "WEB state=$s browser=opened"
    Add-Content $log "$stamp web => state=$s" -Encoding ASCII
  }
  'repair' {
    Add-Content $log "$stamp repair" -Encoding ASCII
    $r = Stop-Dsh
    if ($r -like 'FAIL*') { Write-Host "REPAIR_ABORTED $r"; break }
    $rp = Join-Path $env:USERPROFILE 'Desktop\repair-dsh.ps1'
    if (-not (Test-Path $rp)) { Write-Host 'REPAIR_MISSING script'; break }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $rp -NonInteractive 2>&1 | Add-Content $log -Encoding UTF8
    $web = & "$env:SystemRoot\System32\curl.exe" -sS -m 4 -o NUL -w '%{http_code}' 'http://127.0.0.1:3080' 2>$null
    Write-Host "REPAIR_DONE web=$web"
    Add-Content $log "$stamp repair => $r web=$web" -Encoding ASCII
  }
  'status' {
    Add-Content $log "$stamp status" -Encoding ASCII
    $conn = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) {
      Write-Host 'DOWN no-listener'
      Add-Content $log "$stamp status => DOWN" -Encoding ASCII
      break
    }
    $p = [int]$conn.OwningProcess
    # curl 5s timeout: a frozen listener (connect ok, no reply) also yields 000
    $code = & "$env:SystemRoot\System32\curl.exe" -sS -m 5 -o NUL -w '%{http_code}' 'http://127.0.0.1:3080' 2>$null
    if ($code -ne '000' -and $code -ne '') { Write-Host "UP code=$code pid=$p" }
    else { Write-Host "FROZEN code=$code pid=$p" }
    Add-Content $log "$stamp status => code=$code pid=$p" -Encoding ASCII
  }
}
