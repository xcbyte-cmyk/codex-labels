# Windows 알림 연결 구현 및 검증

## 구현 범위

이 변경은 원본 `codex://` 연결을 바꾸지 않는 선택적 알림 계층입니다. 자동 등록은 하지 않습니다. `launch.ps1 -RegisterNotifications` 실행 시 Labels 전용 시작 메뉴 바로가기와 `codex-labels://` 프로토콜을 등록합니다.

전용 AUMID는 `com.xcbyte.codex-labels`, 고정 CLSID는 `{6C044074-1473-4A87-AF13-7664FCE48F23}`입니다. 다른 이름의 앱이나 원본 Codex 설정은 수정하지 않습니다. 같은 이름의 외부 바로가기는 덮어쓰지 않습니다. 사용자 지정 테스트 프로필에서는 등록을 거부합니다.

프로토콜 등록 명령에는 고정 `--user-data-dir`와 옵션 종료자 `--`를 포함합니다. OS가 실행기를 거치지 않고 EXE를 시작해도 main 확장이 upstream 초기화와 단일 인스턴스 잠금보다 먼저 같은 Labels 프로필을 설정합니다. `CODEX_HOME`은 변경하지 않습니다.

## 경로

```text
명시적 작업 이벤트 / 메뉴의 테스트 알림
  -> 검증된 notifyThread 요청
  -> main process의 Windows toastXml
  -> activationType="protocol", launch="codex-labels://activate?..."
  -> 최초 실행 argv 또는 기존 프로세스의 second-instance
  -> URI 검증 / 짧은 중복 제거 / 마지막 클릭 우선 큐
  -> 신뢰된 renderer의 준비 완료 확인
  -> Labels 창 restore/show/focus
  -> hostId + kind + threadId가 일치하는 보이는 행
  -> 행의 기존 click 동작 -> navigation-requested 응답
```

`Notification.handleActivation` 지원 여부는 진단에 기록하지만 해당 전역 콜백을 교체하지 않습니다. 원본 앱이 자체 콜백을 사용해도 빼앗지 않기 위해 새 알림은 전용 프로토콜 경로를 사용합니다. 따라서 내장 Electron 메이저 버전을 추정해 분기하지 않습니다.

기존 main-process 알림에는 가능할 때 `Notification.prototype.show`를 감싸 표시 직전에 앱 ID를 적용하고 `click` 리스너를 앞에 추가합니다. 클래스 생성자를 교체하거나 기존 클릭 리스너를 제거하지 않습니다. 변경이 불가능한 런타임에서는 `native-hook-unavailable`로 기록하고 원래 동작을 유지합니다.

**기존 콜백이 외부 `codex://`를 여는지, 앱 내부 라우터를 직접 호출하는지는 공개 저장소만으로 확정되지 않습니다.** 이번 구현은 그 private bundle을 추측해 변형하지 않습니다. 기존 알림에 대한 완전한 작업 연결 보장은 해당 설치본의 추가 추적과 Windows 검증이 필요합니다.

## 연동 API

허용된 Codex 화면의 preload bridge에서만 사용할 수 있습니다.

```js
await window.codexLabels.notifyThread({
  threadId: 'actual-thread-id',
  hostId: 'local',
  kind: 'local',
  eventId: 'unique-event-id', // 생략 시 UUID 생성
  title: '답변 필요',
  body: '확인이 필요한 작업이 있습니다.',
  silent: false
});
```

`threadId`는 이벤트를 발생시킨 작업의 실제 ID여야 합니다. 현재 선택된 화면이나 제목에서 추정하지 마세요. `hostId`와 `kind`는 생략 시 `local`입니다. 원격 작업에는 실제 두 값을 반드시 전달하세요. 허용 ID 문자는 영문·숫자·밑줄·하이픈·마침표이며 최대 256자입니다. 이름/본문은 각각 120/1000자, XML에서 허용되지 않는 문자는 거부합니다.

다른 프로세스의 펫이나 알림 도구가 이 API에 자동으로 연결되지는 않습니다. 외부 입력 서버나 범용 셸 IPC는 추가하지 않았습니다. 별도 도구와 연결하려면 그 도구의 실제 이벤트 모델과 신뢰 경계를 확인한 어댑터가 필요합니다. 답변·승인 요청은 알림 내용일 뿐, 승인 버튼을 누르거나 업무 라벨을 바꾸는 명령이 아닙니다.

## 오류와 성능

등록되지 않은 상태에서는 새 알림 생성이 명확한 오류로 종료됩니다. 분당 20회를 넘는 요청을 거부하며 같은 eventId의 재전송은 5초간 제거합니다. 보관하는 알림 객체는 최대 64개, 최대 24시간입니다. OS가 닫힘 이벤트를 보내지 않아도 상한을 넘지 않습니다.

클릭 중복 제거는 2초이며 이후의 의도적인 재클릭을 허용합니다. 활성화 큐는 30초 후 만료됩니다. 준비된 창 중 하나만 대상으로 하고, 잘못된 창의 응답이나 이전 클릭의 응답으로 새 요청을 지울 수 없습니다. 해당 창에 행이 없으면 다른 준비된 창을 시도할 수 있습니다. renderer는 최대 8초간 행 마운트를 기다린 뒤 실패를 알립니다. 메뉴용 콜백은 프레임 이후 실행하여 기존 `stopImmediatePropagation`과 이벤트 리스너 사이 microtask 순서의 영향을 피합니다.

기존 설정 read IPC는 main의 공유 캐시를 사용합니다. directory watcher를 써서 파일 rename 저장을 감지하고 진단/임시 파일 변경은 무시합니다. 감시가 실패해도 5초 캐시 수명 이후 다음 읽기에서 다시 확인합니다. 기존 저장 계층의 revision 충돌 검증은 그대로 유지합니다.

## 진단 해석

`runtime-status.<PID>.json`의 `executable`, `userDataPath`, `electronVersion`으로 실제 실행본을 구분합니다. `notification.enabled`, `protocolRegistered`, `nativeHook`는 준비 상태이며 클릭 성공 증거가 아닙니다.

`nativeShown/nativeClicked`는 **Labels 프로세스에서 관측한 main-process 알림**입니다. 원본 프로세스의 알림 생성 횟수는 알 수 없습니다. `managedShown`은 이 확장의 새 알림이 발행한 show 이벤트입니다. `activations`는 검증된 전용 링크 수신 횟수입니다.

주요 `lastResult`:

- `registration-needed`, `protocol-registration-needed`, `registration-failed`: 등록 전이거나 등록 점검 실패. 실제 Windows 설정과 현재 사본을 확인합니다.
- `profile-in-use-by-another-copy`: 같은 Labels 프로필의 다른 사본이 실행 중입니다. 그 Labels 창만 닫고 원하는 사본에서 다시 등록합니다.
- `waiting-for-renderer`, `delivered-to-renderer`: 클릭 수신/화면 전달 단계입니다.
- `navigation-requested`: 일치하는 행의 click을 호출했다는 의미입니다. 실제 내부 라우터 완료를 검사한 값이 아닙니다.
- `thread-not-found`, `delivery-failed`, `activation-expired`: 작업 미표시, 화면 전달 실패 또는 대기 만료입니다.
- `native-click-forwarded`: 기존 클릭 콜백을 보존한 상태에서 Labels 창 활성화를 요청했습니다.

진단에는 알림 내용과 작업 ID를 저장하지 않습니다. 실행 경로 등은 여전히 개인 정보일 수 있습니다. 공개 이슈에는 원문 대신 필요한 필드만 가려서 공유하세요.

## Windows 수동 인수 검사 — 아직 미실행

원본 앱과 Labels를 함께 실행한 상태에서 메뉴의 테스트 알림을 만듭니다. 클릭 후 Labels가 활성화되고 정확한 host/kind/thread 작업이 열리는지 화면으로 확인합니다. 다음에는 Labels만 종료하고 알림 센터의 같은 테스트 알림을 눌러 새 Labels 프로세스가 같은 프로필로 열리는지 확인합니다. Windows 알림 설정과 집중 지원에 따른 알림 비표시도 별도로 확인해야 합니다.

그 뒤 Labels에서 실제 Codex 질문/승인 알림을 발생시켜 `nativeShown/nativeClicked` 변화를 비교합니다. 원본에서 생성한 알림도 따로 만들어 두 앱의 생성 출처와 중복을 구분합니다. 원본 알림의 클릭 대상을 이 패치가 소급 변경하지 않는 것이 정상입니다.

작업이 접힌 프로젝트, 목록 밖의 가상화 항목, 여러 창과 여러 host, 동일한 thread ID, 새로고침 중 클릭, 연속 클릭도 확인합니다. 잘못된 작업이 열리거나 실패가 성공으로 기록되면 배포하지 않습니다. 브라우저/단위 테스트 통과만으로 이 수동 검증을 완료했다고 표시하지 마세요.

## 등록 해제와 복구

`launch.ps1 -UnregisterNotifications`는 현재 EXE 소유의 전용 프로토콜과 바로가기만 제거합니다. 실행 중 앱에 이미 적용된 ID가 있을 수 있으므로 해제 후 Labels를 종료하세요. 다른 사본으로 옮겼다면 그 사본에서 등록/해제해야 합니다. 원본 Codex와 `codex://`는 복구 작업 대상이 아닙니다.

소스 업데이트는 새 ASAR 빌드가 필요합니다. Labels를 종료한 뒤 `runtime/app`을 백업 이름으로 옮기고 준비 스크립트를 다시 실행합니다. 재빌드가 실패하면 새 런타임을 실행하지 말고 기존 백업을 복원합니다. 개인 labels.json과 assignments.json은 보존됩니다.

## 근거 문서

- Electron notifications: https://www.electronjs.org/docs/latest/tutorial/notifications
- Electron Notification / toastXml: https://www.electronjs.org/docs/latest/api/notification
- Shortcut AUMID / CLSID fields: https://www.electronjs.org/docs/latest/api/structures/shortcut-details
- Electron deep-link / second-instance routing: https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app
- Electron app identity and protocol API: https://www.electronjs.org/docs/latest/api/app

최신 API 문서는 설치된 Owl 런타임의 모든 기능 지원을 보증하지 않으므로 실행 시 기능 탐지와 별도 실제 기기 검증을 사용합니다.
