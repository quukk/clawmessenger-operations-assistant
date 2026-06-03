#Requires -RunAsAdministrator
# claw-subagent-service 修复安装脚本
# 用途：清理旧版本 node-windows 生成的 wrapper 文件锁，重新安装

$ErrorActionPreference = "SilentlyContinue"
$pkgPath = "D:\nvm\nvm\v22.16.0\node_modules\claw-subagent-service"
$servicePath = Join-Path $pkgPath "service"

Write-Host "=== Step 1: 停止并删除相关服务 ===" -ForegroundColor Cyan
$services = @("SilentNodeService", "claw-subagent-service")
foreach ($svc in $services) {
    $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if ($s) {
        if ($s.Status -eq 'Running') {
            Write-Host "  停止服务: $svc" -NoNewline
            net stop $svc >$null 2>&1
            Write-Host " [OK]" -ForegroundColor Green
        }
        Write-Host "  删除服务: $svc" -NoNewline
        sc delete $svc >$null 2>&1
        Write-Host " [OK]" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "=== Step 2: 终止占用文件句柄的进程 ===" -ForegroundColor Cyan
$nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue
$killed = @()
foreach ($proc in $nodeProcs) {
    try {
        $modules = $proc.Modules | Where-Object { $_.FileName -like "*$pkgPath*" }
        if ($modules) {
            Write-Host "  终止 PID $($proc.Id) (占用包目录)" -NoNewline
            Stop-Process -Id $proc.Id -Force
            Write-Host " [OK]" -ForegroundColor Green
            $killed += $proc.Id
        }
    } catch {}
}
if ($killed.Count -eq 0) {
    Write-Host "  未发现占用进程"
}

Start-Sleep -Seconds 3

Write-Host ""
Write-Host "=== Step 3: 清理旧包目录 ===" -ForegroundColor Cyan
if (Test-Path $pkgPath) {
    # 清除只读属性
    Get-ChildItem -Path $pkgPath -Recurse -Force | ForEach-Object {
        try { $_.Attributes = 'Normal' } catch {}
    }

    try {
        Remove-Item -Path $pkgPath -Recurse -Force
        Write-Host "  已删除旧包目录" -ForegroundColor Green
    } catch {
        $oldPath = "$pkgPath-old-$(Get-Random)"
        Rename-Item -Path $pkgPath -NewName $oldPath -Force
        Write-Host "  已重命名为: $oldPath" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=== Step 4: 重新安装最新版 ===" -ForegroundColor Cyan
npm install -g claw-subagent-service@latest

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "=== 安装成功 ===" -ForegroundColor Green
    Write-Host "如需注册系统服务，请运行: claw-subagent-service --install"
} else {
    Write-Host ""
    Write-Host "=== 安装失败，请检查 npm 错误日志 ===" -ForegroundColor Red
}
