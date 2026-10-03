@echo off
start "" "%SystemRoot%\System32\wscript.exe" "%~dp0scripts\launch-batch.vbs" stop
exit /b
