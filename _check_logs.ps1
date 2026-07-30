Write-Output "=== 检查 exhibition 相关进程 ==="
$procs = Get-Process | Where-Object { 
    $_.ProcessName -like '*exhibition*' -or 
    $_.ProcessName -like '*agent*' -or 
    $_.ProcessName -eq 'node' -or 
    $_.ProcessName -eq 'go'
}
if ($procs) {
    $procs | Format-Table Id, ProcessName, StartTime
} else {
    Write-Output "没有找到相关进程"
}

Write-Output "`n=== 检查端口占用 ==="
netstat -ano | Select-String "38921|3000" | ForEach-Object { $_ }
