# register-autostart.ps1 - 开机自启配置（需管理员，弹一次 UAC）
# 1) QQbridge 登录自启：计划任务 ONLOGON + HIGHEST（静默提权，无 UAC 弹窗）
# 2) SnowLuma(QQ 网关) 登录自启：启动文件夹快捷方式（普通权限）
param()
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $MyInvocation.MyCommand.Path + '"'))
  exit
}

Write-Host '=== 注册 QQbridge 登录自启（HIGHEST，无 UAC）===' -ForegroundColor Cyan
# 用当前脚本所在目录，避免硬编码用户名路径
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$startBat = Join-Path $here 'start.bat'
schtasks /Create /TN 'QQbridge-AutoStart' /TR "`"$startBat`"" /SC ONLOGON /RL HIGHEST /RU $env:USERNAME /F
schtasks /Query /TN 'QQbridge-AutoStart' /FO LIST | Select-String 'TaskName|状态|登录时|Run As User|Logon'

Write-Host '=== 创建 SnowLuma 启动文件夹快捷方式 ===' -ForegroundColor Cyan
$startup = [Environment]::GetFolderPath('Startup')
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut((Join-Path $startup 'SnowLuma-QQ.lnk'))
$s.TargetPath = 'C:\SnowLuma\launcher.bat'
$s.WorkingDirectory = 'C:\SnowLuma'
$s.Save()
Write-Host ('快捷方式已建: ' + (Join-Path $startup 'SnowLuma-QQ.lnk'))

Write-Host ''
Write-Host '完成。下次自动登录后 SnowLuma 与 bridge 会自动拉起。' -ForegroundColor Green
