#!/bin/zsh
set -eu
cd "${0:A:h}"
if ! command -v python3 >/dev/null || ! xcode-select -p >/dev/null 2>&1; then
  print 'Python 3.11 이상과 Apple Command Line Tools가 필요합니다. docs/macos.md를 확인하세요.'
  exit 1
fi
python3 prepare_macos.py
print '준비 완료. launch-macos.command를 실행하세요.'
