# Codex Labels macOS 개발 버전

Apple M1 맥북에서 라벨 표시·지정·해제와 라벨 설정 저장을 확인했습니다.

## 실행

GitHub의 macOS 미리보기 릴리스에서 설치 소스 ZIP을 내려받고 압축을 푸세요. Python 3.11 이상, Apple Command Line Tools, 아래 지원 버전의 공식 앱이 필요합니다. 약 3GB 이상의 여유 공간을 준비하세요.

1. `install-macos.command`를 실행하면 해당 맥의 공식 앱으로 별도 사본을 만듭니다.
2. 이후 `launch-macos.command`를 실행하면 라벨용 프로필로 엽니다.

터미널에서 실행하려면 압축을 푼 폴더에서 `zsh install-macos.command`, `zsh launch-macos.command`를 사용하세요. macOS 보안 설정을 전역으로 끄는 절차는 제공하지 않습니다. 첫 실행의 계정·작업 목록 로딩에는 시간이 걸릴 수 있습니다.

사이드바 제목 앞의 ＋를 누르면 상태를 선택할 수 있습니다. 같은 메뉴의 **라벨 설정…**에서 이름과 색상 등을 편집합니다.

## 적용 범위

- Apple M1, macOS 26.5.2에서 검증했습니다.
- 지원 원본 앱 버전: 26.915.31945. 다른 버전은 빌더가 거부합니다.
- 원본 `/Applications/ChatGPT.app`은 수정하지 않았습니다.
- 앱 프로필: `~/Library/Application Support/CodexLabels/User Data`
- 라벨 설정·할당: `~/Library/Application Support/CodexLabels/Config`
- CODEX_HOME과 기존 작업 저장소는 원본 앱과 공유합니다. 이 사본은 작업 파일의 격리 환경이 아닙니다.
- Windows 전용 알림 연결·업데이트 도구 및 활동 동기화 패치는 맥에 적용하지 않습니다.
- 원본 자동 업데이트도 이 사본에서 비활성화했습니다. 새 앱 버전은 호환성 확인 후 다시 빌드해야 합니다.
- 로컬 서명 개발용 사본입니다. 공식 배포판이나 Apple 공증을 받은 앱이 아닙니다. 배포 ZIP에는 설치 소스만 포함되며, 다른 맥에서는 해당 맥의 공식 앱으로 사본을 새로 만듭니다. 음성·푸시 알림 등 macOS 권한이 필요한 모든 부가 기능까지 검증한 것은 아닙니다.

## 검증

- JavaScript 단위 테스트 92개 통과.
- 기존 아카이브 빌드 테스트 7개, 추가 macOS 호환성 테스트 1개 통과.
- 실제 앱 엔진의 합성 사이드바에서 라벨 표시·지정·저장·해제 통과.
- 실제 계정의 사이드바에서 라벨 표시, 진행 지정, 해제 및 설정 저장을 UI로 확인. 검증용 지정은 해제했습니다.
- 전체 Python 검사: 102개 중 Windows API 의존 오류 8개, 건너뜀 45개. 전체 검사를 통과한 것으로 보지 않습니다.

## 소스 재현

소스 ZIP에는 앱 바이너리와 개인 설정이 없습니다. macOS에서 압축을 풀고 실행합니다.

```sh
python3 prepare_macos.py --destination '/원하는/새/경로/Codex Labels.app'
node --test extension/*.test.cjs
python3 -m unittest discover -s tests -p test_prepare_runtime.py
python3 -m unittest discover -s tests -p test_macos_build.py
```

빌더는 기존 대상 앱을 덮어쓰지 않습니다. Windows 기존 동작은 기본 빌드 옵션을 유지합니다. 기존 대상 앱이 있으면 덮어쓰지 않고 중단합니다. 업데이트는 기존 사본을 종료하고 백업한 뒤 재준비하세요.
