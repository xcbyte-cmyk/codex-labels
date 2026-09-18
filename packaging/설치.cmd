@echo off
chcp 65001 >nul
"%~dp0CodexLabelsHelper.exe" launch --shortcut
if errorlevel 1 (
  echo.
  echo 설치를 완료하지 못했습니다. 위 안내를 확인해 주세요.
)
