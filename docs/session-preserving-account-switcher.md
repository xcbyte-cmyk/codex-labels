# 세션 유지형 Account Switcher (실험, #21)

## 상태와 범위

이 변경은 **기본 비활성인 실험 구현**이다. 실제 Windows Codex Desktop의 프로세스 연결, 동일 대화 복원, 선택 계정으로의 모델 요청 및 사용량 귀속을 아직 검증하지 않았다. 합성 백엔드 테스트는 실제 서비스 검증이 아니다. 이 문서의 수동 검증을 끝내기 전에는 안정 기능으로 배포하거나 #21을 완료 처리하지 않는다.

대상은 기존 계정별 실행 도구로 만든 **로그인된 관리 프로필**, 로컬 stdio app-server, 디스크에 저장된 유휴 대화다. 계정 추가·이름 변경·삭제는 기존 도구를 재사용한다. 기본 Labels 창, 원본 공식 Codex, 별도 계정 창의 인증 파일은 바꾸지 않는다. 요청 계정 선택은 현재 프로세스에만 적용되며 앱 재실행 시 원래 프로필 계정으로 돌아간다.

## 구현

- `account-switch-profiles.cjs`: 기존 프로필/로그인을 읽기만 한다. 프로필 ID, 일반 파일 여부, 크기, 삭제 표시, JWT의 계정·사용자 일치와 만료를 검사한다. JWT 파싱은 서명 검증이 아니며 실제 인증은 새 백엔드와 사용량 조회로 확인한다. 토큰과 내부 경로는 renderer IPC로 보내지 않는다.
- `account-session-router.cjs`: Desktop에 보이는 stdio 스트림은 유지하고 백엔드 프로세스만 교체한다. 새 후보 백엔드는 `cli_auth_credentials_store="ephemeral"`과 `account/login/start`의 외부 토큰 로그인으로 인증한다. 기존 `auth.json`을 교체하지 않는다.
- `account-switcher.cjs`: 패키지의 정확한 CLI 경로, 관리 프로필의 CODEX_HOME, stdio app-server 실행만 연결한다. 다른 명령·원격 전송은 가로채지 않는다. 신뢰된 최상위 renderer만 고정 IPC를 호출할 수 있다.
- preload/renderer: 현재 요청 프로필, 수동 사용량 조회, 명시적 계정 전환 확인을 제공한다. 서버가 반환한 시간 창을 표시하고 조회하지 않은 사용량을 0으로 꾸미지 않는다.
- ASAR builder: 새 모듈과 preload를 패키지에 포함한다. 원본 앱은 수정하지 않고 기존 refresh 경로에서 중복 삽입을 방지한다.

전환 순서는 다음과 같다.

1. 진행 중 turn, 승인, 요청이 없는지 확인하고 전환을 직렬화한다. 전환 중 새 요청은 오류를 반환하며 다른 계정으로 몰래 재전송하지 않는다.
2. 로드된 모든 로컬 대화를 조회한다. 저장 경로가 현재 프로필의 sessions 아래인지, 유휴·영속 대화인지, 백그라운드 터미널이 없는지 확인한다.
3. 후보 백엔드를 별도로 시작해 명시적으로 선택한 계정으로 인증하고 identity/사용량을 확인한다.
4. 동일한 로컬 thread ID를 resume한다. turn 기록의 지문, 모델, 작업 디렉터리, 승인·sandbox 등 관측한 설정을 비교한다. 서버가 접근이나 동시 소유권을 거부하면 그대로 실패 처리한다. 접근 제어를 우회하거나 새 원격 thread에 기록을 자동 업로드하지 않는다.
5. 검증을 모두 통과하면 후보로 라우팅을 바꾸고 이전 백엔드를 종료한다. 실패하면 후보만 종료하고 기존 백엔드·화면을 유지한다.

정상 유휴 상태에서만 백엔드를 교체하므로 실행 중 터미널의 메모리 상태를 마이그레이션한다고 주장하지 않는다. renderer의 대화·입력창 DOM을 재생성하지 않는다. 디스크 작업 파일은 그대로지만 프로세스 내 도구·MCP 상태 등은 실제 앱에서 별도 검증해야 한다.

## 개인정보와 계정 경계

전환 확인창은 이후 요청에 기존 대화나 파일 내용이 포함되어 다른 계정/조직의 처리 정책에 적용될 수 있음을 알린다. 해당 데이터와 대상 계정을 사용할 권한이 있을 때만 진행한다. 조직의 로그인·워크스페이스 제한을 우회하지 않는다. 자동 계정 순환, 한도 소진 시 자동 fallback, 제한 회피, 토큰 내보내기는 구현하지 않는다.

이 창의 로컬 작업 저장소는 원래 프로필에 남는다. 따라서 `runtime-status.json`의 `accountProfileId`는 **저장소 프로필**이지 전환 후 요청 계정에 대한 증명이 아니다. 요청 프로필은 별도 스위처 상태로 표시한다. 저장된 프로필 이름이나 JWT 표시 정보만으로 실제 사용량 귀속을 보장하지 않는다.

외부 토큰 갱신 요청은 선택 프로필을 다시 읽되 동일한 계정·사용자 identity인 경우에만 응답한다. refresh token을 직접 회전하지 않는다. 저장된 access token이 만료됐거나 identity가 바뀌면 해당 계정별 창에서 다시 로그인해야 하며 다른 계정으로 자동 전환하지 않는다.

## 테스트 프로필에서 활성화

안정 사용 중인 프로필 대신 테스트용 관리 프로필을 사용한다. 이 PR을 빌드한 실행본을 준비하고 해당 프로필 창을 정상 종료한 뒤 다음 위치에 **내용이 없는 일반 파일** `session-switcher.enabled`를 만든다.

```text
%LOCALAPPDATA%\CodexLabels\AccountWindows\accounts\<32자리 profile-id>\session-switcher.enabled
```

구형 설치 내 관리 프로필은 해당 `accounts/<profile-id>` 디렉터리를 사용한다. 다음 정상 실행부터 실험 버튼이 나타난다. 파일이 없거나 비어 있지 않거나 링크이면 활성화하지 않는다. 비활성화하려면 파일을 제거하고 다음 정상 실행을 이용한다. 이 PR 작성 과정에서는 사용자의 설치본·프로필에 이 파일을 만들지 않았다.

## 안전을 위해 지원하지 않는 경우

- 실제 Desktop이 stdio가 아닌 transport나 다른 spawn 계약을 사용하는 경우, 둘 이상의 로컬 엔진이 같은 창에 연결된 경우.
- 원격/클라우드 대화, 임시 대화, 관측하지 못한 로드 대화, 32개 초과 또는 페이지가 더 있는 목록.
- 진행 중 turn/승인 요청, 백그라운드 터미널, 관측된 host-level shell/process 실행.
- dynamic tools, 초기 thread 설정 외의 per-turn 설정 변경, 복원 기록·실행 설정 불일치.
- 지원되지 않는 background terminal 조회, 토큰 만료, email 확인 불가, 계정 identity 불일치.
- 후보 백엔드의 도구/승인 요청, 원본 백엔드 종료, 요청 시간 초과.

현재 spawn 연결은 ChildProcess facade에 의존한다. Electron/native transport가 추가 속성·이벤트를 요구할 수 있다. 실제 앱 연결을 검증하지 않은 상태에서 “Desktop 세션 유지 구현 완료”라고 해석해서는 안 된다. 알 수 없는 상태에서는 전환을 막고 기존 계정으로 계속한다.

## 자동 검증

```sh
node --test extension/account-session-router.test.cjs extension/account-switch-profiles.test.cjs
CODEX_LABELS_BROWSER_TESTS=1 python -m unittest discover -s tests -p test_account_switcher_renderer.py -v
python -m unittest discover -s tests -p test_account_switcher_build.py -v
```

- Node: 실제 로컬 자식 프로세스로 구동하는 **합성** JSON-RPC 백엔드, A/B 라우팅, 동일 thread ID, 기록 불일치, 실패·timeout rollback, 진행 작업·승인 차단, 프로필 검증, IPC 권한, quota 정규화.
- Chromium: **합성** IPC, 전환 동의, 입력 DOM/선택/스크롤 보존, 악성 프로필 이름의 텍스트 처리, 조회 상태, 원시 오류 비노출.
- ASAR: 작은 합성 원본에 실제 신규 모듈 포함, refresh 중복 방지, 실패 시 기존 파일 보존. 기존 모듈은 fixture를 사용하므로 전체 기존 회귀 검증과는 별개다.

테스트는 실제 토큰, 사용자 대화, 원본 Codex 바이너리, 네트워크를 사용하지 않는다. 전체 기존 회귀·Windows 패키징은 PR CI에서 확인한다.

## Windows 실제 앱 검증 체크리스트 (미완료)

- [ ] 지원 Store/내부 버전에서 정확한 CLI spawn을 한 번만 연결하고 기본 비활성 실행에 회귀가 없다.
- [ ] 두 개의 본인 소유 테스트 계정과 민감하지 않은 로컬 대화로 정상 전환한다.
- [ ] Electron 창/renderer, 대화 ID, 입력 초안·선택·스크롤·cwd·파일 변경이 보존된다.
- [ ] 실제 다음 모델 요청이 B의 identity로 인증되었음을 비밀정보를 남기지 않는 근거로 확인한다. 사용량 숫자 변동만 단독 근거로 삼지 않는다.
- [ ] 단일 대화뿐 아니라 모든 로드 대화에 계정 표시/라우팅이 일치하고 네이티브 account/updated 처리로 UI가 초기화되지 않는다.
- [ ] 동일 CODEX_HOME의 후보 resume가 원본의 소유권과 충돌하지 않는다. 충돌 시 우회하지 않고 기존 계정을 유지한다.
- [ ] 토큰 만료, 인증 거부, 대상 조직 정책 제한, restore 실패, 종료·전환 경합에서 기존 작업을 보존한다.
- [ ] 전환 전후 양쪽 auth.json/쿠키가 변경되지 않고 토큰이 로그·renderer에 노출되지 않는다.
- [ ] 모델·승인·sandbox·MCP 및 도구 상태 보존 범위가 실측과 문서에 일치한다.
- [ ] 기본 Labels/다른 프로필/원본 Codex가 영향을 받지 않고 재시작 시 원래 프로필로 돌아간다.

## 참고

- 공식 app-server 프로토콜: https://developers.openai.com/codex/app-server/
- 조사 기준 upstream: `openai/codex` commit `75db67bbc6a18200b52698c8870adaedd7746dea`, `codex-rs/app-server/src/request_processors/account_processor.rs`의 외부 토큰 로그인 경로. 이는 설치된 Desktop의 동일 구현을 입증하지 않는다.
- 계정 스위처 아이디어 참고: https://github.com/liuzhao1225/codex-account-switcher (소스 코드를 복사하거나 포함하지 않음).
