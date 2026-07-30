$p = netstat -ano | Select-String ":38921"
if ($p) { $pid = $p -replace '.*\s+(\d+)$','$1'; taskkill /F /PID $pid; Start-Sleep 1 }
Start-Process -NoNewWindow -FilePath "go" -ArgumentList "run", "main.go" -WorkingDirectory "e:\PY\exhibition-remote-control\server-go"
Write-Host "Hub restarted on port 38921" -ForegroundColor Green
pause
