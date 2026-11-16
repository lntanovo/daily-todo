# 注册开机自启（登录时自动启动 AstrBot + SnowLuma）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\enable-autostart.ps1
#
# 取消：
#   powershell -ExecutionPolicy Bypass -File scripts\disable-autostart.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root "Start-All.cmd"
$taskName = "DeepSeek-QQ-Bot"

if (-not (Test-Path $target)) {
    throw "找不到 $target"
}

$action = New-ScheduledTaskAction -Execute $target -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "登录后自动启动 QQ 群日程助手（AstrBot + SnowLuma）" | Out-Null

Write-Host "已注册开机自启：$taskName" -ForegroundColor Green
Write-Host "  触发：当前用户登录时"
Write-Host "  执行：$target"
Write-Host ""
Write-Host "取消自启：powershell -ExecutionPolicy Bypass -File scripts\disable-autostart.ps1"
