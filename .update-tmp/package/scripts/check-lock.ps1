# 检查 claw-subagent-service 包目录下的文件锁定情况
$pkgPath = "D:\nvm\nvm\v22.16.0\node_modules\claw-subagent-service"
$servicePath = Join-Path $pkgPath "service"

Write-Host "=== 包目录结构 ===" -ForegroundColor Cyan
Get-ChildItem -Path $pkgPath -Recurse -Force | Select-Object FullName, Length, @{N='Attributes';E={$_.Attributes}} | Format-Table -AutoSize

Write-Host ""
Write-Host "=== 检查 service 目录下是否有 .exe / .xml 文件（node-windows 生成的 wrapper） ===" -ForegroundColor Cyan
if (Test-Path $servicePath) {
    Get-ChildItem -Path $servicePath -Filter "*.exe" -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $servicePath -Filter "*.xml" -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "service 目录不存在"
}

Write-Host ""
Write-Host "=== 服务状态 ===" -ForegroundColor Cyan
sc query "SilentNodeService"
Write-Host ""
sc query "claw-subagent-service"

Write-Host ""
Write-Host "=== 查找加载了包目录的 node 进程 ===" -ForegroundColor Cyan
$nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue
foreach ($proc in $nodeProcs) {
    try {
        $modules = $proc.Modules | Where-Object { $_.FileName -like "*$pkgPath*" }
        if ($modules) {
            Write-Host "PID: $($proc.Id), Path: $($proc.Path)"
        }
    } catch {}
}
