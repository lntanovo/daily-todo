# 启动 SnowLuma（QQ 协议端）
#
# SnowLuma 是「注入式」协议端：它必须注入到一个正在运行的 QQ 客户端进程里。
# 所以 QQ 一旦退出登录，机器人立刻离线。本脚本会先确保 QQ 在跑，再启动 SnowLuma。
#
# 必须用发行包自带的 node.exe（v24.22.1）：系统 node 是 24.16.0，
# 不满足 package.json 的 engines 约束 ^24.22.1，会直接启动失败。
#
# 用法：
#   双击 Start-SnowLuma.cmd，或
#   powershell -ExecutionPolicy Bypass -File scripts\start-snowluma.ps1
#
# 启动后打开 http://127.0.0.1:5099 扫码登录小号。

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root "tools\snowluma"
$node = Join-Path $dir "node.exe"

# 已经跑着就不再重复启动
$busy = Get-NetTCPConnection -State Listen -LocalPort 5099 -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host "SnowLuma 已在运行（5099 已监听），本窗口无需再启动。" -ForegroundColor Yellow
    Write-Host "直接打开 http://127.0.0.1:5099"
    Start-Sleep -Seconds 3
    exit 0
}

if (-not (Test-Path $node)) {
    Write-Host "找不到 SnowLuma 自带的 node.exe：$node" -ForegroundColor Red
    Write-Host "确认已把发行包解压到 tools\snowluma"
    exit 1
}

# ---- 确保 QQ 客户端在跑（注入的前提）----
$qqCandidates = @(
    "D:\APP\QQ\QQ.exe",
    "$env:ProgramFiles\Tencent\QQNT\QQ.exe",
    "${env:ProgramFiles(x86)}\Tencent\QQNT\QQ.exe",
    "$env:LOCALAPPDATA\Programs\Tencent\QQNT\QQ.exe"
)
$qqPath = $qqCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$qqRunning = [bool](Get-Process -Name "QQ" -ErrorAction SilentlyContinue)

if ($qqRunning) {
    Write-Host "QQ 客户端已在运行，直接注入。" -ForegroundColor Cyan
}
elseif ($qqPath) {
    Write-Host "QQ 没在运行，先启动：$qqPath" -ForegroundColor Yellow
    Start-Process $qqPath
    Write-Host "等待 25 秒，请在 QQ 窗口确认小号已登录（可能需要手机确认）…"
    Start-Sleep -Seconds 25
    if (-not (Get-Process -Name "QQ" -ErrorAction SilentlyContinue)) {
        Write-Host "QQ 仍未启动，请手动打开 QQ 登录小号后重新运行本脚本。" -ForegroundColor Red
        exit 1
    }
}
else {
    Write-Host "没找到 QQ 客户端。请先手动打开 QQ 登录小号，再启动 SnowLuma。" -ForegroundColor Red
}

$version = (& $node --version) -replace "v", ""
Write-Host ""
Write-Host "SnowLuma 启动中…" -ForegroundColor Cyan
Write-Host "  使用 node v$version（发行包自带）"
Write-Host "  控制台  ：http://127.0.0.1:5099"
Write-Host "  已开启自动注入（hookAutoLoad=true）"
Write-Host "  关闭本窗口即停止服务"
Write-Host ""

Set-Location $dir
& $node .\index.mjs
