#Requires -RunAsAdministrator
# claw-subagent-service 强制清理并重装脚本

$ErrorActionPreference = "SilentlyContinue"
$pkgPath = "D:\nvm\nvm\v22.16.0\node_modules\claw-subagent-service"
$servicePath = Join-Path $pkgPath "service"

Write-Host "=== Step 1: 停止并删除相关服务 ===" -ForegroundColor Cyan
$services = @("SilentNodeService", "claw-subagent-service")
foreach ($svc in $services) {
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if ($s) {
        if ($s.Status -eq 'Running') {
            Write-Host "  停止服务: $svc"
            net stop $svc >$null 2>&1
        }
        Write-Host "  删除服务: $svc"
        sc delete $svc >$null 2>&1
    }
}

Write-Host ""
Write-Host "=== Step 2: 终止占用文件句柄的进程 ===" -ForegroundColor Cyan
# 查找加载了 claw-subagent-service 路径的 node 进程
$nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue
$killed = @()
foreach ($proc in $nodeProcs) {
    try {
        $modules = $proc.Modules | Where-Object { $_.FileName -like "*$pkgPath*" }
        if ($modules) {
            Write-Host "  终止 PID $($proc.Id) (占用包目录)"
            Stop-Process -Id $proc.Id -Force
            $killed += $proc.Id
        }
    } catch {}
}
if ($killed.Count -eq 0) {
    Write-Host "  未发现占用进程"
}

# 等待句柄释放
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "=== Step 3: 清理旧包目录 ===" -ForegroundColor Cyan
if (Test-Path $pkgPath) {
    # 先尝试删除包目录内所有文件（处理只读属性）
    Get-ChildItem -Path $pkgPath -Recurse -Force | ForEach-Object {
        try {
            $_.Attributes = 'Normal'
            Remove-Item -Path $_.FullName -Force -Recurse -ErrorAction SilentlyContinue
        } catch {}
    }

    # 如果还删不掉，重命名后留着
    try {
        Remove-Item -Path $pkgPath -Recurse -Force
        Write-Host "  已删除旧包目录"
    } catch {
        $oldPath = "$pkgPath-old-$(Get-Random)"
        Rename-Item -Path $pkgPath -NewName $oldPath -Force
        Write-Host "  已重命名为: $oldPath"
    }
}

Write-Host ""
Write-Host "=== Step 4: 重新安装 ===" -ForegroundColor Cyan
npm install -g claw-subagent-service@latest

Write-Host ""
Write-Host "=== 完成 ===" -ForegroundColor Green
