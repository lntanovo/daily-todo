# 把 astrbot_plugin_agenda 装进 AstrBot 的插件目录（幂等，可反复执行）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install-plugin.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "astrbot_plugin_agenda"
$dstDir = Join-Path $root "astrbot\data\plugins"
$dst = Join-Path $dstDir "astrbot_plugin_agenda"

if (-not (Test-Path $src)) { throw "找不到插件源码：$src" }
New-Item -ItemType Directory -Force -Path $dstDir | Out-Null

if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }

Copy-Item -Recurse $src $dst
# 不要把测试缓存带进插件目录
Get-ChildItem $dst -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force

Write-Host "已安装插件 -> $dst" -ForegroundColor Green

$cfgDir = Join-Path $root "astrbot\data\config"
$cfgFile = Join-Path $cfgDir "astrbot_plugin_agenda_config.json"
if (-not (Test-Path $cfgFile)) {
    New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
    Copy-Item (Join-Path $root "config\plugin_config.example.json") $cfgFile
    Write-Host "已生成配置模板 -> $cfgFile（记得填 watch_groups / chat_groups）" -ForegroundColor Yellow
}
else {
    Write-Host "已存在配置，未覆盖 -> $cfgFile" -ForegroundColor Cyan
}
