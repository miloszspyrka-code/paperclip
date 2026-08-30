@echo off

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\paperclip\scripts\runtime\start-core.ps1"
if errorlevel 1 exit /b %ERRORLEVEL%

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\paperclip\scripts\start-kompas-app-mcps.ps1"
if errorlevel 1 exit /b %ERRORLEVEL%

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\paperclip\scripts\runtime\status.ps1"
exit /b %ERRORLEVEL%
