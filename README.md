# Codex Labels

Windows용 Codex의 프로젝트·작업 제목 앞에 상태 라벨을 표시하는 사용자 지정 확장입니다. 라벨 이름과 색상은 앱 안의 설정창에서 바꿀 수 있습니다.

An unofficial Windows customization that adds editable status badges to the Codex sidebar. It patches a local copy of an installed, supported Codex runtime; this repository does not distribute Codex binaries.

## 화면에서 사용하는 방법

1. 아래 설치 절차를 마치고 **Codex Labels**를 실행합니다.
2. 사이드바의 프로젝트·작업 제목 앞에 있는 **＋**를 클릭합니다.
3. 상태를 선택하면 제목 앞에 색상 배지가 표시됩니다.
4. 상태를 바꾸려면 배지를 다시 클릭합니다. **라벨 해제**로 표시를 없앨 수 있습니다.
5. 이름이나 색상을 바꾸려면 같은 메뉴에서 **라벨 설정…**을 엽니다.

설정창은 라벨 이름, 배경색, 글자색, 설명, 표시 순서, 사용 여부를 지원합니다. 글자 크기, 모서리 둥글기, 여백, 제목과의 간격도 미리보기를 보며 조절할 수 있습니다. **저장**하면 같은 라벨을 사용하는 항목들에 함께 반영되고, **취소**하면 편집 내용은 저장하지 않습니다.

| 기본 상태 | 배경색 | 글자색 |
| --- | --- | --- |
| 요청 · 하늘색 | `#7DD3FC` | `#082F49` |
| 진행 · 초록색 | `#22C55E` | `#052E16` |
| 검토 · 주황색 | `#FB923C` | `#431407` |
| 완료 · 남색 | `#1E3A8A` | `#FFFFFF` |
| 보류 · 회색 | `#6B7280` | `#FFFFFF` |

라벨은 사용자가 직접 지정합니다. 에이전트의 응답이 끝났다는 이유로 자동으로 완료 상태로 바뀌지 않습니다. 할당 정보는 제목 문자열 대신 작업·프로젝트 ID를 기준으로 저장합니다.

## 지원 환경

- Windows에 설치된 Microsoft Store Codex **패키지 버전 `26.911.7940.0`**
- 해당 앱의 내부 버전 **`26.911.61220`**
- **Python 3.11 이상**: 설치된 앱의 런타임을 복사하고 패치하는 데 필요합니다.
- Git: 아래 저장소 복제 명령에 필요합니다.
- **Node.js 22 이상**: 확장 저장소 테스트를 실행할 때만 필요합니다.

이 저장소는 위 버전을 대상으로 작성되었습니다. 준비 스크립트는 지원하지 않는 버전을 거부합니다. 이후 Codex 버전에서도 작동한다는 의미는 아닙니다.

사본은 설치된 앱의 **Owl 런타임**을 사용합니다. 별도로 설치한 일반 Electron으로 실행하는 구성은 지원하지 않습니다.

## 설치와 실행

PowerShell에서 다음을 실행합니다.

```powershell
git clone https://github.com/xcbyte-cmyk/codex-labels.git
cd codex-labels
python prepare_runtime.py
powershell -NoProfile -File .\launch.ps1
```

`prepare_runtime.py`는 지원되는 설치본을 찾고 다음 파일을 준비합니다.

- `runtime/app/`: 설치된 Codex를 복사한 뒤 확장을 적용한 실행용 사본
- `labels.json`: `labels.example.json`에서 생성하는 개인 라벨 설정
- `assignments.json`: 처음에는 비어 있는 프로젝트·작업별 라벨 할당 정보

자동 탐색 대신 설치본의 `app` 디렉터리를 지정할 수도 있습니다.

```powershell
python prepare_runtime.py --source 'C:\path\to\Codex\app'
```

`--source`는 버전 검사를 우회하는 옵션이 아닙니다. 지원되는 Codex 설치본을 지정해야 합니다.

준비가 끝난 뒤에는 저장소 디렉터리에서 실행 명령만 다시 사용하면 됩니다.

```powershell
powershell -NoProfile -File .\launch.ps1
```

원본 Codex를 종료할 필요가 없으며, 준비·실행 과정에서 원본 설치 파일을 수정하지 않습니다.

Windows 실행 정책 때문에 직접 작성된 로컬 스크립트가 차단된다면 내용을 확인한 뒤, 해당 실행 프로세스에만 정책을 적용할 수 있습니다. 시스템의 실행 정책 설정은 바꾸지 않습니다. 조직에서 강제한 정책은 관리자 안내를 따르세요.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\launch.ps1
```

여러 복제 폴더는 같은 Codex Labels 앱 프로필을 사용합니다. 다른 복제 폴더로 전환할 때는 기존 **Codex Labels** 창을 먼저 종료하세요. 원본 Codex 창은 계속 열어 두어도 됩니다.

## 설정 파일과 데이터 범위

라벨 관련 파일은 복제한 저장소 디렉터리에 모입니다.

| 파일 | 역할 |
| --- | --- |
| `labels.example.json` | 공개 저장소에 포함된 기본 설정 |
| `labels.json` | 사용자가 수정하는 이름·색상·모양 설정 |
| `labels.json.bak` | 설정창에서 저장하기 직전의 설정 백업 |
| `assignments.json` | 프로젝트·작업 ID와 라벨 ID의 연결 |

설정창에서 저장할 때 라벨 ID는 유지됩니다. 따라서 이름이나 색상을 바꿔도 기존 할당을 계속 사용할 수 있습니다. JSON을 직접 편집할 때도 기존 라벨의 `id`를 유지하세요. 배경색과 글자색은 `#RRGGBB` 형식입니다.

설정창을 열어 둔 사이 다른 창이나 파일에서 설정을 바꾸면, 저장 전에 충돌을 알리고 최신 설정을 다시 불러오도록 합니다. 잘못된 설정을 덮어쓰는 대신 오류를 표시하며, 이미 읽어 둔 유효한 설정은 유지합니다.

앱의 사용자 데이터 디렉터리는 `%LOCALAPPDATA%\CodexLabels\User Data`로 분리합니다. **기존 `CODEX_HOME`과 작업 저장소는 공유합니다.** 별도 앱 프로필은 전체 작업 데이터의 샌드박스가 아니며, 이 창에서 수행하는 작업도 기존 파일과 작업 데이터에 영향을 줄 수 있습니다.

## 구현 구조

```text
설치된 Codex
    └─ 로컬 복사 → runtime/app
                     └─ main / preload / renderer 확장
                              ├─ 사이드바 배지와 상태 메뉴
                              ├─ 라벨 설정창
                              └─ labels.json + assignments.json
```

`extension/main.cjs`는 허용된 앱 화면에만 설정 읽기·저장 기능을 연결합니다. `extension/preload.js`는 필요한 기능만 화면에 전달하고, `extension/renderer.js`는 실제 사이드바 항목에 배지·메뉴·설정창을 추가합니다. `extension/store.cjs`가 설정 검증, 저장 전 충돌 확인, 백업과 파일 저장을 담당합니다.

Codex의 Rust app-server를 빌드하거나 SQLite 스키마를 변경하지 않습니다. 화면 요소를 탐색해 배지를 추가하므로 Codex의 사이드바 구조가 바뀌면 확장 수정이 필요할 수 있습니다.

## 테스트

저장소 루트에서 실행합니다.

```powershell
node --test extension/store.test.cjs
python -m unittest discover -s tests -v
```

Python의 5개 테스트는 합성 archive로 패치 무결성, 원본 보존, 버전 거부와 개인 설정 보존을 확인합니다. 실제 Codex 바이너리는 테스트에 포함하지 않습니다.

저장 계층의 17개 테스트는 라벨 할당 유지, 잘못된 입력 거부, 설정 저장과 백업, 외부 수정 충돌 처리를 검증합니다. 구현 과정에서는 브라우저의 사이드바 테스트 화면에서 설정창의 저장·취소·새로고침 유지와 충돌 표시를 확인했고, 위 지원 버전의 실제 앱 사본에서도 확장 기동과 사이드바 배지 생성을 확인했습니다.

이 검증은 명시된 버전과 환경의 결과입니다. 모든 Windows 환경이나 향후 Codex 릴리스에 대한 호환성 보장은 아닙니다.

## 업데이트와 제거

Codex가 업데이트되면 이 저장소의 지원 버전을 먼저 확인하세요. 지원되지 않는 설치본에 기존 패치를 강제로 적용하지 마세요.

사용을 중단하려면 **Codex Labels 창을 닫고 원본 Codex를 실행**하면 됩니다. 파일까지 제거하려면 필요한 `labels.json`과 `assignments.json`을 보관한 뒤 로컬 복제 디렉터리와 `%LOCALAPPDATA%\CodexLabels\User Data`를 삭제할 수 있습니다. 기존 `CODEX_HOME`이나 작업 저장소는 제거 대상이 아닙니다.

## 공개 저장소에 포함되는 범위

이 저장소에는 직접 작성한 확장 코드, 준비·실행 스크립트, 기본 설정 예제와 테스트만 포함합니다. Codex 실행 파일·리소스 사본, 개인 설정, 로그인 정보, 실행 로그, 실제 라벨 할당 정보는 포함하지 않습니다.

OpenAI의 공식 기능이나 공식 배포판이 아닙니다. Codex 앱 자체는 사용자가 별도로 설치해야 합니다.
