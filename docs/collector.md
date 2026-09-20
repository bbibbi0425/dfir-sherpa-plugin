# Always-on Collector

일반 실험의 진입점은 [더블클릭 launcher](desktop-launcher.md)입니다. 이 문서는 기반 상시 수집기와 개발용 명령을 설명합니다. Windows 로그인 자동 시작은 사용하지 않습니다.

Collector를 한 번 켜 두면 LM Studio에서 DFIR Sherpa Tool을 사용하는 새 대화를 감지하고 실행별 결과를 자동 보관합니다. 매 실험마다 `init`이나 `collect`를 입력할 필요가 없습니다. 기존 [수동 Run 저장](run-results.md)도 유지됩니다.

## 시작과 종료

Node.js와 npm이 PATH에 있는 환경에서는 프로젝트 루트에서 실행합니다.

```powershell
npm run collector
```

콘솔 없이 Windows 백그라운드에서 실행하려면:

```powershell
npm run collector:daemon
```

Node.js/npm을 별도 설치하지 않았다면 LM Studio의 번들 Node.js로 실행할 수 있습니다.

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" scripts/collector_daemon.mjs
```

종료는 foreground에서 `Ctrl+C`, 또는 아래 명령을 사용합니다. 다른 LM Studio 프로세스는 종료하지 않습니다.

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" scripts/collector_daemon.mjs --stop
```

동일 결과 루트에 Collector를 중복 실행하면 두 번째 프로세스는 종료됩니다. 상태와 시작 오류는 `outputs/results/.collector/health.json` 및 daemon 로그에서 확인합니다. LM Studio가 종료되어도 대화 감시는 유지하며 모델 로그 스트림은 재접속합니다.

## LM Studio 설정

Run 식별 상태를 제공하는 플러그인 설치본을 갱신합니다.

```powershell
& "$env:USERPROFILE\.lmstudio\bin\lms.exe" dev --install
```

새 분석 채팅에서 `local/dfir-sherpa`를 켜고 **Canonical timeline DB**를 지정합니다. 자동 모드에서는 `SHERPA_RUN_ID`와 `SHERPA_LOG_DIR`를 비워도 됩니다. 별도 환경변수도 필요하지 않습니다.

Collector는 대화 파일에 다음 Tool의 첫 호출이 저장되면 Run을 만듭니다.

- `dataset_overview`
- `search_records`
- `get_record`
- `get_context`

한 conversation 파일이 하나의 Run입니다. 새 실험에는 새 채팅을 사용하세요. 같은 대화를 계속 사용하거나 재생성하면 새 Run 폴더를 추가하는 대신 같은 폴더를 갱신합니다. 선택된 응답 버전과 모든 대화 버전은 원본 복사본으로 확인할 수 있습니다.

## Run ID와 summary 연결

채팅의 명시적 `SHERPA_RUN_ID`를 우선 사용합니다. 없으면 플러그인이 Tool 상태에 전달한 `DFIR_SHERPA_RUN:` 식별자를 사용하고, 구버전 플러그인처럼 상태 식별자가 없으면 Collector가 생성합니다.

자동 이름은 `데이터셋명_YYYYMMDD_HHMMSS` 형태이며 충돌 방지 접미사가 붙을 수 있습니다. 데이터셋명은 설정된 DB 파일명에서 안전한 문자로 된 이름을 얻을 수 있을 때만 사용합니다. 이름을 얻을 수 없으면 `run_YYYYMMDD_HHMMSS`를 사용합니다. 파일명은 데이터셋 식별용이며 실제 사건 분류나 정답을 추론하지 않습니다.

SDK의 Tool 호출 문맥에는 conversation ID가 없으므로 전역 '현재 Run ID'를 공유하지 않습니다. 플러그인은 모델에게 전달되지 않는 Tool 상태로 식별자를 제공하고, Collector가 **conversation 파일과 메시지·버전 내 call ID**를 기준으로 첫 식별자를 확정합니다. provider가 다시 만들어져 다른 상태 식별자를 내보내더라도 같은 conversation은 기존 Run에 연결하며 관측된 식별자를 manifest에 남깁니다.

자동 summary는 저장된 Tool 요청·응답에서 재구성합니다. 기존 summary 생성 함수를 공유하며 반환 크기와 `elapsed_ms`는 실제 응답에서 가져옵니다. `timestamp_source: collector_observation`은 해당 시각이 Collector 관측 시각임을 나타냅니다. 원래 Tool 실행 시각으로 가장하지 않습니다.

기존 설정 기반 플러그인 JSONL 기록은 그대로 동작합니다. 명시적으로 `init`한 수동 Run 폴더가 있으면 자동 Collector는 그 Run을 중복 관리하지 않으므로 기존 `collect`를 사용하세요. 서로 다른 대화가 같은 Run ID를 요청하면 충돌 접미사로 분리합니다.

## 저장 파일

```text
outputs/results/<run_id>/
├── run.json                 Run 상태, 원본 경로·해시, 수집 범위와 누락 정보
├── prompt.txt               사용자 메시지 텍스트
├── <run_id>_tools.jsonl      본문 없는 Tool summary
├── tool-events.jsonl        Tool 요청·결과·상태 이벤트 원문
├── model-response.md        마지막 assistant 응답의 일반 텍스트
├── model-response.json      응답 텍스트, JSON 파싱 결과, 상태
├── model-statistics.json    대화에 저장된 genInfo 원형
├── model.log                해당 Run에 유일하게 연결되는 model stream JSONL
└── conversation.json        원본 LM Studio conversation 바이트 복사본
```

`tool-events.jsonl`과 `conversation.json`에는 Tool 반환 본문이 포함됩니다. summary에는 넣지 않습니다. 여러 사용자 메시지는 `prompt.txt`에서 구분하며 정확한 전체 구조는 대화 복사본에 보존합니다.

응답의 추론 블록·Tool 결과·구조 토큰은 `model-response.md`에서 제외합니다. JSON 응답도 이 파일에서는 공백과 텍스트를 그대로 보존합니다. `model-response.json`은 `{status, stop_reason, text, parsed_json, parse_error}` envelope이며 원문이 순수 JSON이 아니면 `parsed_json`은 null입니다. 빈 응답을 완성된 분석 결과로 표시하지 않습니다.

## 모델 로그와 통계

Collector가 아래 프로세스를 `windowsHide` 옵션으로 실행하고 표준 출력을 수집합니다.

```text
lms log stream --source model --filter input,output --stats --json
```

원본 model 이벤트는 `outputs/results/.collector/model-events/`에 보존되어 재시작 후 재대조할 수 있습니다. 이 저장소에는 다른 모델 실행의 이벤트도 들어갈 수 있으므로 전체 결과 폴더를 로컬 비공개 자료로 취급합니다.

현재 LM Studio 로그에는 conversation ID가 없습니다. 자동 연결은 다음과 같이 보수적으로 수행합니다.

- 입력: 모델 식별자, 해당 생성 시점까지의 사용자 프롬프트 포함 여부, 네 Sherpa Tool 이름을 대조하여 후보가 한 Run뿐일 때 연결합니다. 후속 질문이 추가되어도 앞선 생성의 입력을 유지합니다.
- 출력: 모델 식별자와 전체 `stats` 객체가 대화의 생성 통계와 정확히 일치하고 후보가 한 Run뿐일 때 연결합니다.
- 두 Run에서 같은 프롬프트나 같은 통계를 관측해 연결이 모호하면 각 Run에 복사하지 않고 공통 원본 저장소에 남깁니다. 시각이 가깝다는 이유만으로 배정하지 않습니다.

`promptTokensCount`, `totalTimeSec`, `timeToFirstTokenSec` 등 stats 값은 다시 계산하지 않습니다. `model.log`는 원본 JSON 라인이고 `model-statistics.json`은 대화에 있던 genInfo입니다. 둘을 같은 출처로 가장하지 않습니다.

Collector 시작 전에 발생했거나 스트림 연결이 끊긴 동안의 원본 이벤트는 복구할 수 없을 수 있습니다. `run.json`의 `model_capture`에 `partial_or_unavailable`과 누락 건수를 기록합니다. 대화의 통계가 있어도 없어진 원본 스트림을 만들어내지 않습니다. 동일 프롬프트를 여러 Run에 쓰는 실험에서는 특히 input 로그의 자동 연결이 모호할 수 있습니다.

## 종료 판단과 복구

`completed`는 마지막 assistant 응답이 정상 종료했고, 마지막 Tool 이벤트 이후에 최종 일반 텍스트가 있으며, 저장된 모든 대상 Tool 요청에 결과와 성공 상태가 있을 때만 표시합니다. 파일 저장이 안정될 때까지 기본 3초를 기다립니다.

사용자 중단·토큰 제한·모델 해제·실패는 `interrupted`로, 종료 근거 없이 기본 120초 이상 변화가 없으면 `unknown`으로 보존합니다. 단순히 시간이 지났다는 이유로 완료 처리하지 않습니다. 원본 대화가 나중에 갱신되면 같은 Run을 다시 확인합니다.

재시작 시 기존 conversation과 Run manifest를 스캔합니다. conversation 경로의 식별 해시로 중복 폴더 생성을 막고, 이벤트 ID로 JSONL 중복 append를 막습니다. Collector가 쓰던 JSONL의 마지막 줄이 중간에 끊겼다면 해당 바이트를 `.partial-*` 백업으로 보존하고 완전한 줄부터 복구합니다. LM Studio 원본 파일에는 이 처리를 하지 않습니다.

DB는 파일 읽기로만 해시를 계산합니다. 호출 전 대화를 관측했다면 그때의 baseline을 사용합니다. 최초 Tool 호출 후 감지하거나 과거 Run을 복구했다면 baseline은 **첫 감지/복구 시점**입니다. 이를 과거 실행 전 해시로 표시하지 않습니다. `database.baseline_scope`, `before_captured_at`, `unchanged_since_baseline`을 함께 확인하세요.

Model stream 누락 상태와 모델 실행의 완료 상태는 별개입니다. 완료된 Run도 `model_capture`가 partial일 수 있습니다.

## 경로와 테스트

기본 conversation 경로는 `%USERPROFILE%\.lmstudio\conversations`, 결과 경로는 프로젝트의 `outputs/results`입니다. `--conversation-dir`, `--results-root`, `--lms`, `--poll-ms`, `--idle-ms`, `--settle-ms`로 조정할 수 있습니다. `--once --no-model-stream`은 테스트용 일회 스캔입니다.

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" --test tests/collector.test.mjs
```

합성 데이터로 자동 감지·ID 생성·네 Tool 이벤트·응답 보존·Run별 모델 로그·두 Run 연속 처리·재시작 복구·중단 상태·중복 방지·DB hash 불변을 검사합니다. 생성된 파일은 Git에서 제외되며 실제 실험 결과나 로컬 경로를 공개 문서에 복사하지 않습니다.
