# 取消开机自启
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\disable-autostart.ps1

$ErrorActionPreference = "Stop"
$taskName = "DeepSeek-QQ-Bot"

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "没有找到自启任务 $taskName，无需取消。" -ForegroundColor Yellow
    exit 0
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "已取消开机自启：$taskName" -ForegroundColor Green
