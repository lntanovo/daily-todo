# 启动 AstrBot（OneBot v11 服务端在 6199，等待 SnowLuma 反连）
#
# 用法：
#   双击 Start-AstrBot.cmd，或
#   powershell -ExecutionPolicy Bypass -File scripts\start-astrbot.ps1
#
# 环境变量：
#   ASTRBOT_ROOT  数据根目录，默认指向 ..\astrbot

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$astrbotRoot = Join-Path $root "astrbot"

# 已经跑着就不再重复启动
$busy = Get-NetTCPConnection -State Listen -LocalPort 6185 -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host "AstrBot 已在运行（6185 已监听），本窗口无需再启动。" -ForegroundColor Yellow
    Write-Host "直接打开 http://127.0.0.1:6185"
    Start-Sleep -Seconds 3
    exit 0
}

New-Item -ItemType Directory -Force -Path $astrbotRoot | Out-Null
# 清掉上次异常退出残留的锁
Remove-Item (Join-Path $astrbotRoot "astrbot.lock") -Force -ErrorAction SilentlyContinue
$env:ASTRBOT_ROOT = $astrbotRoot

$astrbot = Join-Path $root ".uv\bin\astrbot.exe"
if (-not (Test-Path $astrbot)) {
    Write-Host "找不到 $astrbot" -ForegroundColor Red
    Write-Host "请先执行：uv tool install astrbot --python 3.12"
    exit 1
}

Write-Host "AstrBot 启动中…" -ForegroundColor Cyan
Write-Host "  数据目录：$astrbotRoot"
Write-Host "  控制台  ：http://127.0.0.1:6185"
Write-Host "  关闭本窗口即停止服务"
Write-Host ""

Set-Location $astrbotRoot
& $astrbot run
