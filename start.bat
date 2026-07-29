@echo off
chcp 65001 >nul
title 123 就出发 — 一键启动

cd /d "%~dp0"

echo.
echo ============================================================
echo   123 就出发 — 本地一键启动
echo ============================================================
echo.

REM 检查 Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js
    echo.
    echo 请先安装 Node.js 18 或更高版本:
    echo   https://nodejs.org/
    echo.
    echo 安装时务必勾选 "Add to PATH" 选项
    echo.
    pause
    exit /b 1
)

echo [信息] Node.js 已安装: 
node -v
echo.

REM 运行首次启动引导
echo [信息] 检查环境配置...
call node scripts\setup.js
if %errorlevel% neq 0 (
    echo.
    echo [错误] 启动引导失败
    pause
    exit /b 1
)

REM 启动服务
echo.
echo ============================================================
echo   启动服务中... 浏览器将自动打开 http://localhost:3000
echo   按 Ctrl+C 可停止服务
echo ============================================================
echo.

REM 延迟 2 秒后自动打开浏览器
start /min cmd /c "timeout /t 2 >nul && start http://localhost:3000"

call npm start

pause
