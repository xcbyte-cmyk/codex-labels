# Codex Labels

Windows용 Codex의 프로젝트·작업 제목 앞에 상태 라벨을 표시하는 비공식 확장입니다. 이름과 색상은 앱 안에서 편집합니다. 원본 설치본 대신 **로컬 앱 사본**에 적용하며 Codex 바이너리를 배포하지 않습니다.

An unofficial, version-gated Windows customization. This repository contains extension source and tests, not Codex binaries or user data.

## 상태 라벨

Codex Labels 창에서 제목 앞 **＋ → 상태 선택**을 사용합니다. 배지를 다시 누르면 상태를 변경하거나 해제할 수 있습니다. 같은 메뉴의 **라벨 설정…**에서 이름, 배경색, 글자색, 설명, 순서, 사용 여부, 글자 크기, 모서리와 여백을 수정합니다. 저장 전 미리보기와 취소, 외부 편집 충돌 차단, 직전 설정 백업을 제공합니다.

기본값은 요청 `#7DD3FC`, 진행 `#22C55E`, 검토 `#FB923C`, 완료 `#1E3A8A`, 보류 `#6B7280`입니다. 연결은 제목이 아닌 작업·프로젝트 ID로 유지합니다. **알림 발생이나 AI 응답 종료가 업무 라벨을 자동으로 완료로 바꾸지는 않습니다.**

## 지원 환경

Windows x64, Microsoft Store Codex **패키지 `26.911.7940.0` / 내부 앱 `26.911.61220`**을 지원합니다. 배포 ZIP은 Python·Git·Node.js 설치 없이 사용할 수 있습니다. 소스에서 준비하려면 Python 3.11 이상, Node.js 22 이상은 테스트용입니다. 지원하지 않는 앱 버전과 이미 패치된 설치본은 거부합니다. 설치본의 Owl 런타임을 그대로 사용하며 일반 Electron 실행 파일로 교체하지 않습니다.

앱 프로필은 `%LOCALAPPDATA%\CodexLabels\User Data`로 분리하지만 **CODEX_HOME과 작업 저장소는 원본과 공유**합니다. 별도 프로필은 작업 파일 전체의 샌드박스가 아닙니다.

## 다른 Windows PC에서 간편 설치

1. 해당 PC에 위 지원 버전의 공식 Codex를 설치합니다.
2. [최신 릴리즈](https://github.com/xcbyte-cmyk/codex-labels/releases/latest)에서 `Codex-Labels-...-windows-x64.zip`을 받고, 계속 사용할 폴더에 압축을 풉니다.
3. **설치.cmd**를 한 번 실행합니다. 설치본 자동 탐색, 버전 검사, 라벨 실행본 준비, 바탕화면 바로가기를 생성합니다.
4. 이후에는 **바탕화면 Codex Labels** 또는 **실행.cmd**만 사용합니다.

공식 앱 실행 파일이나 계정 정보를 배포 ZIP에 포함하지 않습니다. 각 PC의 설치본으로 사본을 만들며, 로그인도 각 PC에서 합니다. 관리자 권한이나 PowerShell 실행 정책 변경 없이 동작합니다. 약 3GB의 여유 공간이 필요합니다.

업데이트할 때는 Labels만 닫고 새 ZIP을 같은 폴더에 풀어 **설치.cmd**를 다시 실행합니다. 개인 설정·할당을 유지하고 이전 실행본을 백업합니다. 설정 자동 동기화는 제공하지 않습니다. [다른 PC 설치와 업데이트 안내](docs/windows-install.md)를 참고하세요.

## 소스에서 설치와 실행

```powershell
git clone https://github.com/xcbyte-cmyk/codex-labels.git
cd codex-labels
python prepare_runtime.py
powershell -NoProfile -File .\launch.ps1
```

설치 경로를 지정하려면 `python prepare_runtime.py --source 'C:\path\to\Codex\app'`을 사용합니다. `--source`는 버전 검사를 우회하지 않습니다.

준비 스크립트는 `runtime/app` 사본을 스테이징 디렉터리에서 완성·검증한 뒤 게시합니다. 원본 ASAR를 불필요하게 한 번 더 복사하지 않으며, 실패한 스테이징 디렉터리는 정리합니다. 원본 설치 경로와 권한은 변경하지 않습니다.

원본 Codex는 계속 실행해도 됩니다. 여러 저장소 사본은 동일한 Labels 프로필을 쓰므로 **다른 사본으로 이동할 때는 기존 Labels 창부터 종료**하세요.

조직의 PowerShell 정책을 따르세요. 실행 정책을 영구적으로 변경하는 설치 명령은 제공하지 않습니다.

## 라벨 설정

라벨 배지를 누른 뒤 **라벨 설정… → ＋ 라벨 추가**에서 새 라벨을 만들 수 있습니다. 이름·배경색·글자색·설명·표시 순서를 편집하고 **저장**하면 지정 메뉴에 반영됩니다. **취소**는 저장하지 않은 추가와 편집을 모두 취소합니다. 최대 100개까지 지원하며 기존 라벨 ID와 작업 지정은 유지됩니다.

업데이트된 실행 도구를 기존 설치 폴더에 적용했다면 Labels를 종료한 뒤 바탕화면 바로가기 또는 `실행.cmd`로 다시 실행하세요. 새 확장 파일을 준비한 뒤 앱을 엽니다. 준비 중에는 기존 설정을 보존하고 이전 런타임을 백업하며, 실행 중인 앱을 강제로 종료하지 않습니다.

## Windows 알림 연결 — 실험적

목표는 **알림 클릭 → Codex Labels 활성화 → 알림의 작업 열기 요청**입니다. 등록은 명시적으로 수행합니다.

```powershell
powershell -NoProfile -File .\launch.ps1 -RegisterNotifications
```

Labels 전용 시작 메뉴 바로가기, AUMID와 `codex-labels://` 프로토콜을 등록합니다. **원본 `codex://` 연결은 변경하지 않습니다.** 등록 후 작업의 배지 메뉴에서 **알림 연결 테스트**를 실행할 수 있습니다. 실제 결과는 `runtime-status.json`의 `notification`에서 확인합니다.

중요한 적용 범위:

- `notifyThread`에 작업 ID를 명시한 새 알림과 테스트 알림: 전용 프로토콜, 시작 시 인자 수신, 실행 중 두 번째 인스턴스 전달, renderer-ready 대기, host/kind/thread 전체 일치로 연결합니다.
- Labels 프로세스의 기존 main-process `Notification`: 지원되는 경우 표시 직전에 Labels 앱 ID를 적용하고 클릭 시 Labels 창을 복원합니다. **기존 작업 열기 콜백을 보존하며, 그 콜백에서 감춰진 작업 ID를 추측하거나 자동 추출하지 않습니다.**
- 원본 Codex에서 생성한 알림, 이미 알림 센터에 남아 있는 원본 알림, renderer의 Web Notification은 가로채지 않습니다.

**현재 패치는 실제 사용자 Windows에서의 토스트 클릭을 검증한 결과가 아닙니다.** 특히 기존 Codex 알림의 콜백이 외부 `codex://` 링크를 여는 경우까지 고쳤다고 주장하지 않습니다. 작업이 가상화·접힘 등으로 DOM에 없으면 다른 작업을 열지 않고 안내합니다. 내부 Codex 라우터를 추측해 호출하지 않습니다.

구조, 연동 API, 제한, 등록 해제와 실제 기기 점검 절차는 [알림 구현 문서](docs/notifications.md)를 참조하세요.

## 데이터와 진단

`labels.example.json`만 공개 기본값입니다. 개인 `labels.json`, `labels.json.bak`, `assignments.json`, 앱 프로필, 로그와 바이너리는 Git에서 제외합니다. 설정 ID를 유지하면 이름과 색상을 바꿔도 기존 할당을 유지합니다.

`runtime-status.json`과 `runtime-status.<PID>.json`에는 실행 파일, PID, 앱 프로필, 내장 Electron 버전, 알림 기능 지원 여부와 처리 결과를 기록합니다. 알림 제목·본문·작업 ID는 진단 상태에 기록하지 않습니다. 진단에는 개인 경로가 있을 수 있으므로 원문을 공개 업로드하지 마세요.

`launch-status.json`은 실행 요청이지 성공 증거가 아닙니다. 기존 Labels 창으로 전달된 경우 요청 프로세스와 실제 활성 프로세스의 PID가 다를 수 있습니다. `notification.lastResult = navigation-requested`도 내부 라우터의 최종 화면을 검증했다는 의미는 아닙니다.

## 최적화와 안전장치

설정은 main process의 공유 캐시로 읽습니다. 디렉터리 감시로 원자적 파일 교체를 감지하며, 누락된 이벤트는 최대 5초 캐시 수명과 다음 읽기로 보완합니다. 저장과 할당은 기존 저장 계층에서 최신 파일을 검증합니다. 진단 쓰기는 100ms 단위로 합칩니다.

알림 클릭은 중복을 제거하고 마지막 클릭을 우선합니다. 다른 창·오래된 요청의 응답은 거부합니다. 알림 생성은 분당 20회, 유지 객체는 64개로 제한합니다. 작업 탐색 observer는 클릭 대기 중에만 설치하고 성공·실패·화면 종료 시 해제합니다. IPC는 기존 허용 앱의 최상위 프레임만 수신합니다. 외부 링크로 임의 명령, 승인, 파일 접근을 실행하지 않습니다.

## 테스트

```powershell
node --test
python -m unittest discover -s tests -v
```

선택적 실제 Chromium 테스트:

```powershell
python -m pip install playwright==1.57.0
python -m playwright install chromium
$env:CODEX_LABELS_BROWSER_TESTS = '1'
python -m unittest discover -s tests -p 'test_*renderer.py' -v
```

저장소 CI는 기존 저장 테스트, 새 알림/IPC/캐시 테스트, 합성 ASAR 빌드 테스트, Windows PowerShell 구문 검사와 별도 Chromium 테스트를 실행합니다. 테스트는 개인 데이터·Codex 바이너리·실제 Windows 알림 등록을 사용하지 않습니다. Chromium 테스트도 **합성 사이드바의 실제 브라우저 검증**이지 Windows 알림 센터 E2E 검증은 아닙니다.

## 소스 업데이트 후 재빌드

`git pull`만으로 기존 `runtime/app` 안의 코드가 바뀌지 않습니다. Labels 창만 종료하고 다음을 실행하세요. 원본 Codex는 종료할 필요가 없습니다.

```powershell
Rename-Item .\runtime\app ('app.backup-' + (Get-Date -Format yyyyMMdd-HHmmss))
python prepare_runtime.py
powershell -NoProfile -File .\launch.ps1 -RegisterNotifications
```

기존 개인 설정과 할당은 덮어쓰지 않습니다. 실행기는 이전 빌드의 영수증 없는 런타임을 거부하여 새 기능이 적용된 것처럼 오인하지 않도록 합니다. Codex 자체가 업데이트되었다면 지원 버전을 먼저 확인하세요.

## 제거

알림 연결을 해제하려면 해당 사본에서 `powershell -NoProfile -File .\launch.ps1 -UnregisterNotifications`를 실행하고 Labels를 종료합니다. 자신이 소유한 바로가기와 전용 프로토콜만 해제합니다. 다른 사본의 연결은 지우지 않습니다.

필요한 개인 설정을 백업한 뒤 저장소 사본과 Labels 전용 프로필을 제거할 수 있습니다. **CODEX_HOME이나 기존 작업 저장소는 제거 대상이 아닙니다.** 원본 Codex를 그대로 사용하면 됩니다.

OpenAI 공식 기능이나 공식 배포판이 아닙니다.
