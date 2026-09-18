# 공통 실행본 계정 애드온 개발판

## 실행 구조

addons/account-windows/launcher.py --install-root <개발 설치 폴더>로 선택기를 연다.
현재는 Python/Tk 및 저장소 모듈을 사용하는 소스 개발판이다. 독립 배포 EXE는 아직 만들지 않았다.
애드온은 공통 runtime/app/ChatGPT.exe 하나를 재사용한다. 실행본 복사 기능은 없다.

새 계정은 %LOCALAPPDATA%/CodexLabels/AccountWindows/accounts/<ID>에 저장한다.
외부 프로토타입의 profiles/profile.json 대신 기존 검증된 accounts/account.json 형식을 유지했다.
기존 app-accounts/accounts는 자동 이전하지 않으며, 프로토콜 인자가 없는 기존 계정 실행도 유지한다.

## 연결 및 보호

- accountHostProtocol=1 빌드 기록과 ASAR 해시, helper 소스 지문을 확인한 후 실행한다.
- --codex-labels-account-protocol=1은 고정된 외부 저장소를 선택한다. 지원하지 않는 연결 규칙은 중단한다.
- 설치 폴더 잠금은 계정 실행의 준비 완료까지 유지하며 삭제도 같은 잠금을 사용한다.
- 삭제는 외부 데이터 위치와 공통 실행 파일 위치를 별도로 전달해 선택 계정만 종료한다.
- 단어장 directory/home은 기존 계정 host의 값을 그대로 사용한다.
- 계정 창의 업데이트 적용 및 알림 연결 제한을 유지하고 자동 업데이트 사전 조회도 중단한다.

## 로컬 시험

work/account-addon-test는 배포가 아닌 별도 개발 설치본이다.
verify.py는 이 시험본만 다시 패치하고 임시 A/B를 생성해 실행·재실행·삭제 검증 후 정리한다.
사용 중인 앱이나 실제 A/B 데이터는 연결하지 않는다.
실제 로그인·구독 사용량은 검증하지 않았다.

## 남은 일

독립 애드온 패키징, 전체 TOML 파서의 Node bootstrap 통합, 업데이트 실패/롤백과 계정 실행의 동시성 실기,
기존 A/B 이전 및 복구 절차, 단어장 후속 버전 통합이 남았다.
현재 결과는 개발판 공통 실행본 연결이며 이슈 전체 완료 또는 사용자 앱 전환이 아니다.
