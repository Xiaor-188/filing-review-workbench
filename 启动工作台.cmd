@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing_node
node -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)"
if errorlevel 1 goto missing_node
if exist "node_modules\pdfjs-dist\package.json" goto run
call npm ci --ignore-scripts
if errorlevel 1 goto failed
:run
echo 启动后请打开下方输出的本地地址。
echo 请保持此窗口运行，结束时按 Ctrl+C。
call npm start
if errorlevel 1 goto failed
exit /b 0
:missing_node
echo 请先安装 Node.js 24 或以上：https://nodejs.org/en/download
pause
exit /b 1
:failed
echo 启动未完成，请查看上方错误。端口占用时可先关闭旧服务。
pause
exit /b 1
