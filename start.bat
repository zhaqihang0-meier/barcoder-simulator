@echo off
cd /d "%~dp0"
echo.
echo  Barcoder 本地服务器
echo  浏览器将打开 http://localhost:3456
echo  关闭此窗口即可停止服务
echo.
start "" "http://localhost:3456"
npx --yes serve . -p 3456
