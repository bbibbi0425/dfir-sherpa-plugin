@echo off
start "" "%SystemRoot%\System32\wscript.exe" "%~dp0scripts\setup-wizard.vbs" reset
exit /b
