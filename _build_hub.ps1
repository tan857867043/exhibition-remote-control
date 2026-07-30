Set-Location "server-go"
Write-Output "Building Hub..."
go build ./...
if ($LASTEXITCODE -eq 0) {
    Write-Output "BUILD SUCCEEDED"
} else {
    Write-Output "BUILD FAILED: $LASTEXITCODE"
}
Read-Host "Press Enter"
