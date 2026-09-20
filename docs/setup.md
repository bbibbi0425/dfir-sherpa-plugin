# Windows 설치 및 배포

## 처음 설치

1. LM Studio를 설치하고 한 번 실행합니다. Tool 호출 지원 모델을 내려받고 SQLite 파일을 준비한 뒤 저장소를 쓰기 가능한 폴더에 압축 해제하거나 clone합니다.
2. `setup.cmd`를 더블클릭합니다. LM Studio 실행 파일이 기본 위치에 없으면 해당 실행 파일의 경로만 묻습니다. DB 경로는 입력하지 않습니다.
3. 완료 메시지와 바탕화면 **DFIR Sherpa Experiment** 바로가기를 확인합니다.

Windows/LM Studio 0.4.24 기준입니다. `%USERPROFILE%\.lmstudio` 아래 번들 Node.js(`node:sqlite` 지원)와 `bin/lms.exe`가 필요합니다. PATH 설정, 별도 npm 설치, 관리자 권한은 필요하지 않습니다. 최초 의존성 설치에는 인터넷이 필요합니다. LM Studio는 설치 중 열어 두세요. Windows Script Host가 조직 정책으로 차단되어 있다면 관리자에게 허용된 실행 방법을 문의하세요. setup은 실행 정책이나 보안 설정을 변경하지 않습니다.

설치 작업은 런타임·CLI 지원 여부를 확인하고 `lms dev --install --yes`로 플러그인을 설치한 뒤 바로가기를 생성합니다. setup은 DB를 열거나 경로를 저장하지 않습니다. 설치 실패 시 완료로 표시하지 않습니다. CLI 설치 이후 오류가 발생하면 플러그인만 갱신된 상태일 수 있으며 오류를 해결하고 setup을 다시 실행합니다.

## 매 실험 실행

1. 바탕화면 **DFIR Sherpa Experiment**를 더블클릭하고 Ready 메시지를 기다립니다.
2. LM Studio의 **새 채팅**에서 모델과 `local/dfir-sherpa`를 선택합니다. **Canonical timeline DB**에 분석할 SQLite 파일의 절대 경로를 입력한 뒤 Prompt를 실행합니다.
3. 응답 완료 후 프로젝트의 `outputs/results/<run_id>/`에서 결과를 확인합니다. 종료 명령은 필요하지 않습니다.

모델·플러그인 선택 및 LM Studio 자체 Tool 승인 정책은 사용자가 관리합니다. setup은 채팅이나 승인 정책을 바꾸지 않습니다. Collector와 model stream은 launcher가 관리하고 여러 새 채팅을 연속 수집합니다. 로그인 자동 시작은 등록하지 않습니다.

## 사용자 설정과 경로

| 항목 | 위치 |
|---|---|
| 사용자 로컬 설정 | `%USERPROFILE%\.lmstudio\dfir-sherpa\local-config.json` |
| 로컬 플러그인 | `%USERPROFILE%\.lmstudio\extensions\plugins\local\dfir-sherpa` |
| 결과 | `<repository>/outputs/results/<run_id>/` |
| 설치 성공·실패 보고 | `<repository>/outputs/setup-result.json`, `setup-error.json` |
| Launcher 오류 | `<repository>/outputs/launcher-error.json` |

로컬 설정에는 프로젝트, LM Studio 실행 파일, CLI 경로만 저장합니다. DB 경로는 LM Studio의 **Canonical timeline DB** 설정에서만 받습니다. 이전 버전의 로컬 `database_path`는 무시하며 setup을 다시 실행하면 파일에서도 제거됩니다. 개인 경로는 코드나 저장소 설정에 들어가지 않습니다. launcher 설정은 현재 Windows 사용자별 하나이며, 여러 checkout을 쓰면 마지막 setup의 프로젝트가 기준입니다. 바로가기는 Windows Desktop 특수 폴더를 사용하므로 바탕화면 이동/OneDrive 리디렉션도 반영합니다.

DB는 read-only로 조회합니다. 빈 값·상대 경로는 `DB_NOT_CONFIGURED`, 없거나 접근 불가능한 파일은 `DB_NOT_FOUND`를 반환합니다. 다른 DB나 setup 설정으로 fallback하지 않습니다. DB를 바꿀 때는 새 채팅을 만들고 새 경로를 입력하면 되며 setup을 다시 실행할 필요가 없습니다. 프로젝트 자체를 옮겼을 때만 새 위치에서 setup을 다시 실행하세요. 이전 위치의 결과는 자동 이동하지 않습니다.

Run 생성 시 `run.json`의 `database.path`, `filename`, `sha256`, `bytes`에 실제 DB의 절대경로·파일명·SHA-256·바이트 크기를 기록합니다. `before`에는 기존 hash 스냅샷도 보존합니다. 새 플러그인은 모델에게 보이지 않는 Tool 상태에 DB 경로를 남겨 Collector가 실제 사용 경로를 확인할 수 있게 합니다. 구버전 채팅은 감지 시점의 채팅 설정을 사용하며 `binding_source`로 구분합니다. 접근 실패로 메타정보를 얻지 못하면 null과 `DB_METADATA_UNAVAILABLE`을 기록하고 `completed`로 처리하지 않습니다.

최초 Tool 실행 후 DB 변경은 허용하지 않습니다. 같은 플러그인 실행의 후속 호출은 `DB_PATH_CHANGED`로 거절합니다. 후속 Prompt나 플러그인 재시작 이후의 변경도 Collector가 감지하면 `database.binding_error=DB_PATH_CHANGED`, `path_changed=true`, Run 상태 `interrupted`로 기록합니다. 최초 DB 정보는 유지하고 변경 이후의 호출은 정상적인 단일 DB 실험으로 인정하지 않습니다. 이를 발견한 Run은 새 채팅에서 다시 시작하세요. setup과 Collector는 원본 LM Studio 채팅 설정을 수정하지 않습니다.

개발·격리 테스트는 `SHERPA_CONFIG_PATH`에 절대 경로를 지정해 기본 설정 위치를 바꿀 수 있습니다. 일반 사용에는 설정할 필요가 없습니다. 과거 `outputs/launcher-settings.json`의 개발용 실행 파일 override가 있으면 launcher에서 로컬 설정보다 우선합니다.

`outputs/` 전체는 Git에서 제외됩니다. 결과에는 프롬프트와 전체 Tool 응답 등 민감한 데이터가 포함될 수 있으므로 각자의 로컬 디스크에서 관리하세요.

## 초기화와 제거

분석이 끝난 상태에서 `reset.cmd` 또는 `uninstall.cmd`를 더블클릭하고 확인창을 승인합니다.

- reset: 확인된 소유 Collector와 model logger 종료, 로컬 설정 삭제. 플러그인·바로가기 유지.
- uninstall: 위 작업에 더해 `local/dfir-sherpa` 설치본과 이 프로젝트 소유 바로가기 제거. LM Studio를 다시 시작해 메모리의 플러그인도 해제합니다.
- 두 경우 모두 DB·원본 채팅·모델·결과 폴더는 보존됩니다. 다시 설치하려면 setup을 실행합니다.

같은 이름의 다른 바로가기는 덮어쓰거나 삭제하지 않습니다. PID와 실행 신원을 확인할 수 없는 Collector, 다른 플러그인 manifest, 연결된 설치 디렉터리는 작업을 중단하고 보고합니다. 수동 `experiment:start`로 시작한 Run은 기존 `experiment:stop` 절차로 먼저 마무리해야 합니다.

저장소를 먼저 지웠거나 LM Studio를 먼저 제거해 스크립트를 실행할 수 없다면, LM Studio와 Collector가 종료된 상태에서 **위 표의 이 플러그인 설치 폴더·로컬 설정 파일·소유 바로가기만** 수동으로 제거합니다. `.lmstudio` 전체나 `outputs/results`를 삭제할 필요는 없습니다.
