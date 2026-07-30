# 重启 Hub (Go) 和前端

Write-Host "=== 终止占用 38921 和 3000 端口的进程 ===" -ForegroundColor Yellow
$goPid = netstat -ano | Select-String ":38921" | ForEach-Object { $_ -split '\s+' | Select-Object -Last 1 }
$webPid = netstat -ano | Select-String ":3000" | ForEach-Object { $_ -split '\s+' | Select-Object -Last 1 }

if ($goPid -and $goPid -ne "0") {
    taskkill /F /PID $goPid 2>$null
    Write-Host "Killed Go (PID: $goPid)" -ForegroundColor Green
}
if ($webPid -and $webPid -ne "0") {
    taskkill /F /PID $webPid 2>$null
    Write-Host "Killed Web (PID: $webPid)" -ForegroundColor Green
}

Start-Sleep -Seconds 1

Write-Host "`n=== 启动 Hub ===" -ForegroundColor Yellow
$goJob = Start-Process -NoNewWindow -PassThru -FilePath "go" -ArgumentList "run", "main.go" -WorkingDirectory "e:\PY\exhibition-remote-control\server-go"

Start-Sleep -Seconds 2

Write-Host "`n=== 启动前端 ===" -ForegroundColor Yellow
$webJob = Start-Process -NoNewWindow -PassThru -FilePath "npm" -ArgumentList "run", "dev" -WorkingDirectory "e:\PY\exhibition-remote-control"

Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "Hub:  http://localhost:38921"
Write-Host "Web:  http://localhost:3000"
Write-Host "`n按 Ctrl+C 可以终止本脚本监控" -ForegroundColor Gray

# 保持窗口打开
pause
