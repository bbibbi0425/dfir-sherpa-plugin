# Tool 호출 JSONL 계측

provider는 조회 결과를 받은 뒤 `toolLogging.mjs`로 메타정보를 기록하고, 조회 결과 객체를 그대로 반환한다.
계측은 검색 결과 선정과 Tool 반환 구조·output 상한에 영향을 주지 않는다.
최종 assistant 응답의 자동 파일 저장은 제공하지 않는다.

## 설정

LM Studio 채팅별 플러그인 설정에 다음 두 문자열을 지정한다. Tool 인자가 아니므로 모델이 바꿀 수 없다.

- `SHERPA_RUN_ID`: 1~80자, 영문/숫자로 시작하며 영문/숫자/`_`/`-`만 허용.
- `SHERPA_LOG_DIR`: 절대 디렉터리 경로. 없으면 생성한다.

각 설정이 빈 문자열이면 같은 이름의 환경변수를 사용한다. 둘 다 미설정이면 로깅을 끈다.
하나만 설정하거나 잘못된 값이면 명시적으로 오류를 보고하며 retrieval 결과는 유지한다.
환경변수는 **LM Studio 플러그인 프로세스가 시작될 때 상속한 값**이다.
이미 실행 중인 앱에는 다른 터미널의 환경변수 변경이 전달되지 않으므로 채팅 설정을 사용하는 것이 명확하다.

파일 경로: `<SHERPA_LOG_DIR>/<SHERPA_RUN_ID>_tools.jsonl`.
동일 run ID는 기존 파일에 계속 append하므로 별도 실험에는 새 run ID를 지정한다.
DB 경로는 기존 `Canonical timeline DB` 설정을 유지한다.

## 기록 계약

각 Tool implementation이 반환한 직후 UTC ISO timestamp와 메타정보를 기록한다.
한 번의 append 쓰기로 UTF-8 JSON과 LF 한 개를 추가한다. 정상 응답과 오류 JSON 모두 기록한다.
SDK가 implementation 진입 전에 거부한 호출은 이 계층에 도달하지 않아 기록하지 않는다.

공통: `run_id`, `timestamp`, `tool`, `elapsed_ms`, `returned`, `output_bytes`, `success`.
오류 응답에는 `error` 코드도 기록한다.

- search: `query`, `total_matches`, `truncated`, `max_results`, `returned_line_ids`, `filters`.
  filters에는 지정된 source/event_type/timestamp 경계만 남겨 재현에 사용한다.
- record: `requested_line_id`, `found`, `truncated`. byte 크기는 공통 `output_bytes`.
- context: `requested_line_id`, `before`, `after`, `returned_line_ids`.
- overview: `total_records`. 실제 레코드는 반환하지 않으므로 `returned`는 0.

응답에 없는 값은 null로 구분한다. `output_bytes`는 `Buffer.byteLength(JSON.stringify(result), 'utf8')`이며
로그 줄 자체의 크기가 아니다. `elapsed_ms`는 기존 Tool의 실행시간 그대로이며 파일 쓰기와 모델 추론 시간을 포함하지 않는다.
subject/detail/payload/snippet과 전체 응답 JSON은 로그에 저장하지 않는다.

## 실패 처리와 원본 보호

기존 파일을 truncate/수정/회전/삭제하지 않는다. 다른 형식의 파일, 끝 LF가 없는 불완전한 파일,
다른 run의 파일, symlink/hard link 대상은 거부한다. DB와 로그 파일의 파일 식별자도 비교한다.
로그 디렉터리 외에 원본 데이터나 forensic DB를 쓰는 동작은 없다.

오류는 stderr에 `sherpa_log_error` JSON으로, LM Studio에는 해당 Tool의 `warn`으로 알린다.
실패한 로그를 성공으로 표시하지 않으며 Tool 반환값에 필드를 추가하거나 오류로 바꾸지 않는다.
영구 저장을 강제하는 fsync는 하지 않는다. 중단으로 마지막 줄이 불완전하면 이를 자동 수리하지 않고 오류를 보고한다.
조회 모듈의 기본 stderr 로그와 JSONL 파일 로그는 별도로 기록된다.

## 검증

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" --test tests/tool_logging.test.mjs tests/dataset_overview.test.mjs tests/search_records.test.mjs tests/record_tools.test.mjs
```

번들 계약 테스트에서는 로깅 비활성/활성 상태의 네 Tool 결과를 비교한다.
서로 다른 실행의 `elapsed_ms`는 자연스럽게 달라지므로 제외하고 비교하며,
같은 결과 객체는 로깅 전후 `elapsed_ms`까지 포함해 byte-for-byte 동일한지 검사한다.

단위 테스트는 호출당 한 줄, 기존 내용 보존 append, 독립 JSON 파싱, Unicode/개행 이스케이프,
UTF-8 응답 크기와 메타정보 일치, 오류 응답 기록, 환경변수/설정 우선순위를 다룬다.
쓰기 실패 및 경고 전달 실패 시 반환값 보존, 불완전한 로그와 DB hard link 보호도 확인한다.
번들 계약 테스트 실행법은 [search 문서](search.md#테스트와-benchmark)에 있다.

## LM Studio에서 로그 확인

새 smoke 채팅에서 DB 경로와 두 로그 설정을 지정한다. 다음은 가상 예시다.

```text
SHERPA_RUN_ID=smoke_example_01
SHERPA_LOG_DIR=C:\experiment-logs
```

[smoke test 절차](overview-smoke.md)에 따라 호출 전에 DB snapshot을 만들고 네 Tool을 각각 한 번 호출한다.
로그 파일 `C:\experiment-logs\smoke_example_01_tools.jsonl`에 네 줄이 추가되는지 확인한다.
검증 스크립트는 네 줄을 기대하므로 이 확인에는 다른 호출이 없는 새 run ID를 사용한다.

아래 경로는 예시이며 DB, 해당 LM Studio 채팅 파일, 호출 전 snapshot, 로그 경로를 실제 값으로 바꿔 실행한다.
JSONL smoke 검증에서는 run ID를 채팅별 플러그인 설정에 직접 지정한다.

```powershell
$nodeExe = "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe"
$dbPath = 'C:\data\timeline.sqlite'
$smokeChat = Read-Host '검증할 LM Studio 채팅 JSON의 전체 경로'
$runId = 'smoke_example_01'
$toolLog = 'C:\experiment-logs\smoke_example_01_tools.jsonl'
& $nodeExe scripts/verify_lmstudio_smoke.mjs --db $dbPath --conversation $smokeChat --baseline outputs/smoke-baseline.json --report outputs/smoke-instrumentation.json --jsonl $toolLog --run-id $runId
```

`--jsonl`과 `--run-id`는 함께 사용한다. 검증은 실제 LM Studio Tool 요청/응답 및 성공 이벤트와
JSONL의 시간·크기·건수·ID 목록을 대조하고 DB 불변 여부를 확인한다.
같은 DB·입력으로 실행한 비교용 채팅이 있으면 `--compare-conversation PATH`로 추가 대조할 수 있다.
서로 다른 실행의 `elapsed_ms`는 비교에서 제외하며, 비교용 채팅도 네 Tool을 같은 순서로 호출해야 한다.

기존 보고서는 덮어쓰지 않는다. 로그와 채팅 파일에는 검색 조건과 식별자 등 연구 정보가 포함될 수 있으므로
실제 파일과 검증 보고서는 공개 문서에 복사하지 않고 로컬에 보관한다. 프로젝트 안에서는 Git에서 제외된 `outputs/`를 사용할 수 있다.
