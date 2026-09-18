# 계정 애드온과 단어장 병행 개발

## 개발 기준

- 공통 공개 기준: 6a2e4c3.
- 로컬 보존 기준: f679ff6. 기존 계정·삭제·단어장 변경을 포함하는 개발 스냅샷이며 출시 완료 커밋이 아니다.
- 계정 작업: work/account-addon, codex/account-windows-addon.
- 단어장 작업: 기존 전용 worktree와 기능 브랜치 유지. PR9 후속 개선은 이 기준에 아직 포함되지 않았다.
- source는 기존 미커밋 상태로 보존한다. 이 폴더에서 기능 브랜치를 번갈아 checkout하지 않는다.
- 런타임, 계정 데이터, 로그인 정보는 Git 기준에 포함하지 않는다.

## 합의된 연결 규칙

1. main의 신뢰된 host가 configDirectory와 CODEX_HOME을 결정한다. renderer 또는 IPC 입력으로 경로를 바꾸지 않는다.
2. registerVocabulary의 directory는 선택 계정의 configDirectory, home은 선택 계정의 CODEX_HOME을 전달한다.
3. 명시적 계정 실행에서 경로가 없거나 잘못되면 중단한다. 기본 계정으로 fallback하지 않는다. 기본 창 실행에만 기본 home을 사용할 수 있다.
4. 요약 자식 프로세스에도 선택 home을 전달하며 다른 계정/API 인증 환경을 제거하는 기존 동작을 보존한다.
5. 계정별 단어장 저장 분리, save/delete revision 충돌 검사, 요약 draft 검증을 유지한다.
6. vocabularyRead/Summarize/Cancel/Save/Delete IPC, sender 검사, 메뉴 이벤트, renderer 주입 및 빌드 포함 목록을 보존한다.
7. 종료 시 vocabulary.dispose로 진행 중 요약을 정리한다.

이 규칙은 2026-09-18 단어장 담당 작업의 회신으로 합의했다. 새 profile-host 구현의 통합 완료를 의미하지 않는다.

## 변경과 통합 순서

- 다른 worktree라도 codexlabels workspace와 저장소 상대 경로로 충돌을 확인하고 예약한다.
- 각 기능은 작은 커밋으로 나눈다. 공통 main/preload/renderer/builder 파일은 필요한 변경만 병합한다.
- PR9 전체 main.cjs를 가져오지 않는다. 단어장 개선은 담당자가 지정한 변경 또는 이후 합의된 커밋만 검토해 반영한다.
- 계정 프로필 연결부를 통합할 때 기존 account-profile과 profile-host를 중복 활성화하지 않는다.
- 임시 A/B에서 단어장 저장·검색·삭제 및 요약 home 분리를 검사하고, 기본 창 회귀 검사를 수행한다.
- 각 개발 시험 후 별도 통합 시험본에서 함께 확인한다. 실제 앱 교체와 데이터 이전은 별도 단계다.

## 현재 남은 계정 작업

외부 1차 소스는 work/issue7-local-test/imported에 있으며 아직 이 브랜치에 적용하지 않았다.
Windows 축약 경로 처리, 기존 삭제 기능 연결, 준비 완료 확인 및 업데이트/삭제 잠금 설계가 필요하다.
현 단계는 개발 환경 분리와 기존 변경 보존 완료이며 공통 실행본 애드온 완성이나 배포가 아니다.
