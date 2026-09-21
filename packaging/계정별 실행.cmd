@echo off
chcp 65001 >nul
"%~dp0CodexLabelsHelper.exe" accounts
if errorlevel 1 pause
