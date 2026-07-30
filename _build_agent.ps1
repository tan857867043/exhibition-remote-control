Set-Location "e:\PY\exhibition-remote-control\agent-rust"
cargo build 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Output "BUILD SUCCEEDED"
} else {
    Write-Output "BUILD FAILED with exit code: $LASTEXITCODE"
}
Read-Host "Press Enter to exit"
