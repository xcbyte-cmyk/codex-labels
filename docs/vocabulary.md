# 단어장 — 로컬 개발 기능

답변에서 단어 또는 짧은 구절을 드래그하고 선택 메뉴의 **단어장**을 누릅니다. 현재 창의 Codex 로그인으로 **gpt-5.6-luna / xhigh**가 뜻과 짧은 예문을 생성합니다. 결과를 확인하고 **단어장에 저장**을 눌러야 저장됩니다.

저장한 항목은 라벨 배지 또는 ＋ 메뉴의 **단어장…**에서 다시 볼 수 있습니다. 단어 또는 뜻으로 검색할 수 있고, **삭제 → 삭제 확인**으로 항목을 제거합니다. 같은 단어를 다시 저장하면 기존 항목을 갱신합니다. 대소문자, 전각 문자와 연속 공백을 정규화하여 중복을 판별합니다.

## 실행 및 저장 범위

- 모델: `gpt-5.6-luna`, reasoning effort: `xhigh`. 다른 모델로 자동 대체하지 않습니다.
- 앱에 포함된 `resources/codex.exe exec`와 현재 `CODEX_HOME`의 파일 기반 ChatGPT 로그인을 사용합니다. 별도 API 키를 사용하거나 다른 계정으로 자동 전환하지 않습니다. 사용량은 해당 로그인 계정에 귀속됩니다.
- 기본 창은 기존 Codex 홈, 계정별 창은 해당 계정의 `codex-home`을 사용합니다. 파일 기반 로그인 정보가 없으면 로그인 오류를 표시합니다.
- 선택한 문자열 최대 160자와 해당 문단의 주변 문맥 최대 1,600자만 요약 입력으로 보냅니다. 전체 대화는 보내지 않습니다.
- 임시 실행은 `--ephemeral`, `--ignore-user-config`, 읽기 전용 sandbox로 시작합니다. 사용자 설정의 MCP, 플러그인, 앱, 메모리, 셸 도구, 서브에이전트와 웹 검색을 비활성화하고 프로젝트 지침을 불러오지 않습니다. 단어를 셸 인자가 아닌 stdin 자료로 전달합니다.
- 창별로 동시 요약 1건, 120초 시간 제한. 취소, 화면 이동, 창 종료 시 해당 요청을 종료합니다. 요약이 실패하거나 취소되면 저장 버튼이 활성화되지 않습니다.
- `vocabulary.json`을 해당 창의 라벨 저장 폴더에 보관합니다. 기본 창은 `app/vocabulary.json`, 계정별 창은 `app-accounts/accounts/<id>/vocabulary.json`입니다. 서로 공유하지 않습니다.
- 저장 한도 2,000개 / 8MB. 원자적 파일 교체, 쓰기 잠금, revision 비교로 다른 창의 변경을 덮어쓰지 않습니다. 손상된 파일은 초기화하지 않고 오류를 표시합니다. 쓰기 중 비정상 종료로 `.lock` 폴더가 남은 경우 모든 Labels 창을 닫고 쓰기 작업이 없는지 확인한 뒤 해당 빈 잠금 폴더만 정리합니다.
- AI 요약은 사전 원문 인용이 아닙니다. 불확실한 용어는 불확실성을 밝히도록 요청합니다.

## 검증

```powershell
node --test extension/vocabulary.test.cjs extension/ipc.test.cjs
py -3.13 -m unittest discover -s tests -p test_prepare_runtime.py -v
$env:CODEX_LABELS_BROWSER_TESTS='1'
py -3.13 -m unittest discover -s tests -p test_vocabulary_renderer.py -v
```

Chromium 검사는 실제 브라우저에서 현재 지원 버전의 선택 툴바 DOM 구조와 테스트용 IPC를 사용합니다. 실제 Codex 창의 검증과 구분합니다. `CODEX_LABELS_CHROMIUM`으로 설치된 Chromium 경로를 지정할 수 있고, `CODEX_LABELS_VOCABULARY_ARTIFACTS`를 지정하면 툴바 및 라이트/다크 화면을 저장합니다.

소스 변경만으로 현재 실행 중인 앱이 바뀌지는 않습니다. 새 실행본을 준비·검증하고, 해당 설치본의 모든 창을 닫은 뒤 교체해야 합니다. 공개 릴리스와는 별도인 로컬 개발 기능입니다.
