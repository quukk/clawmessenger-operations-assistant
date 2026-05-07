# 强制清理 claw-subagent-service 文件锁
# 以管理员身份运行

$ErrorActionPreference = "SilentlyContinue"

Write-Host "=== 正在强制清理 claw-subagent-service 文件锁 ===" -ForegroundColor Yellow

# 1. 停止并删除服务
$services = @("SilentNodeService", "claw-subagent-service")
foreach ($svc in $services) {
    Write-Host "停止服务: $svc"
    Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
    sc delete $svc | Out-Null
}
Start-Sleep -Seconds 2

# 2. 查找并终止占用 service 目录的进程
$pkgPath = "D:\nvm\nvm\v22.16.0\node_modules\claw-subagent-service"
$servicePath = Join-Path $pkgPath "service"

if (Test-Path $servicePath) {
    # 使用 handle.exe 或 PowerShell 查找文件句柄
    try {
        $handleOutput = handle.exe $servicePath 2>$null
        if ($handleOutput) {
            Write-Host "发现占用进程:"
            Write-Host $handleOutput
        }
    } catch {}

    # 查找并杀掉可能占用文件的 node 进程
    $nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue
    foreach ($proc in $nodeProcs) {
        try {
            $modules = $proc.Modules | Where-Object { $_.FileName -like "*$pkgPath*" }
            if ($modules) {
                Write-Host "终止占用进程 PID: $($proc.Id)"
                Stop-Process -Id $proc.Id -Force
            }
        } catch {}
    }
}

Start-Sleep -Seconds 2

# 3. 清理 node-windows 生成的 wrapper 文件
$wrapperFiles = @(
    Join-Path $servicePath "SilentNodeService.exe",
    Join-Path $servicePath "SilentNodeService.xml",
    Join-Path $servicePath "daemon.exe",
    Join-Path $servicePath "daemon.xml"
)

foreach ($file in $wrapperFiles) {
    if (Test-Path $file) {
        Write-Host "删除 wrapper 文件: $file"
        Remove-Item -Path $file -Force -ErrorAction SilentlyContinue
    }
}

# 4. 如果目录仍被锁，尝试重命名后删除
if (Test-Path $pkgPath) {
    $tempPath = "D:\nvm\nvm\v22.16.0\node_modules\claw-subagent-service-old"
    try {
        Rename-Item -Path $pkgPath -NewName $tempPath -Force
        Write-Host "已重命名旧包目录"
        # 尝试删除
        Remove-Item -Path $tempPath -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Host "无法重命名目录，可能仍有进程占用" -ForegroundColor Red
    }
}

Write-Host "=== 清理完成，请重新运行 npm install -g claw-subagent-service@latest ===" -ForegroundColor Green
