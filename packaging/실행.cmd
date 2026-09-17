@echo off
chcp 65001 >nul
"%~dp0CodexLabelsHelper.exe" launch
if errorlevel 1 pause
