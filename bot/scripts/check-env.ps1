# 环境自检：确认 Python / uv / AstrBot / SnowLuma / 插件是否就位
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\check-env.ps1

$root = Split-Path -Parent $PSScriptRoot
$ok = $true

function Check($name, $path, $hint) {
    if (Test-Path $path) {
        Write-Host "[ OK ] $name" -ForegroundColor Green
    }
    else {
        Write-Host "[MISS] $name  -> $hint" -ForegroundColor Yellow
        $script:ok = $false
    }
}

Write-Host "工程根目录：$root`n"

$astrbotExe = Join-Path $root ".uv\bin\astrbot.exe"
Check "AstrBot 可执行" $astrbotExe "执行 uv tool install astrbot --python 3.12"
Check "AstrBot 数据目录" (Join-Path $root "astrbot\data") "先运行一次 start-astrbot.ps1"
Check "插件已安装" (Join-Path $root "astrbot\data\plugins\astrbot_plugin_agenda\main.py") "执行 scripts\install-plugin.ps1"
Check "插件配置" (Join-Path $root "astrbot\data\config\astrbot_plugin_agenda_config.json") "执行 scripts\install-plugin.ps1"
Check "SnowLuma 发行包" (Join-Path $root "tools\snowluma\launcher.bat") "解压 tools\SnowLuma-v2.4.2-win-x64.zip 到 tools\snowluma"

Write-Host ""
if (Test-Path $astrbotExe) {
    Write-Host "AstrBot 版本：$(& $astrbotExe --version 2>&1)"
}

Write-Host ""
if ($ok) {
    Write-Host "环境就绪。" -ForegroundColor Green
}
else {
    Write-Host "还有缺项，见上面的 [MISS]。" -ForegroundColor Yellow
}
