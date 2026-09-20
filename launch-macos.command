#!/bin/zsh
set -eu
cd "${0:A:h}"
APP="$PWD/runtime/Codex Labels.app"
if [[ ! -d "$APP" ]]; then
  print '먼저 install-macos.command를 실행하세요.'
  exit 1
fi
PROFILE="$HOME/Library/Application Support/CodexLabels/User Data"
mkdir -p "$PROFILE"
open -n "$APP" --args --user-data-dir="$PROFILE"
