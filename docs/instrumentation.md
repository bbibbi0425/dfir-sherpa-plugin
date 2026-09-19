# Tool 호출 JSONL 계측

retrieval 모듈 `searchRecords.mjs`, `recordTools.mjs`, `datasetOverview.mjs`는 변경하지 않는다.
provider에서 결과를 받은 뒤 `toolLogging.mjs`가 메타정보 한 줄을 기록하고 같은 결과 객체를 반환한다.
검색 알고리즘, sampling, Tool schema/반환 구조, output 상한은 그대로다.
최종 assistant 분석 JSON 저장은 구현하지 않는다.

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
로그 디렉터리 외에 원본 CSV나 forensic DB를 쓰는 동작은 없다.

오류는 stderr에 `sherpa_log_error` JSON으로, LM Studio에는 해당 Tool의 `warn`으로 알린다.
실패한 로그를 성공으로 표시하지 않으며 Tool 반환값에 필드를 추가하거나 오류로 바꾸지 않는다.
영구 저장을 강제하는 fsync는 하지 않는다. 중단으로 마지막 줄이 불완전하면 이를 자동 수리하지 않고 오류를 보고한다.
기존 세 Tool의 최소 stderr 로그는 유지한다.

## 검증

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" --test tests/tool_logging.test.mjs tests/dataset_overview.test.mjs tests/search_records.test.mjs tests/record_tools.test.mjs
```

번들 계약 테스트에서는 로깅 비활성/활성 상태의 네 Tool 결과를 비교한다.
서로 다른 실행의 `elapsed_ms`는 자연스럽게 달라지므로 제외하고 비교하며,
같은 결과 객체는 로깅 전후 `elapsed_ms`까지 포함해 byte-for-byte 동일한지 검사한다.

## 검증 결과 (2026-09-19)

단위 테스트 30개와 플러그인 번들 연결 테스트 1개, 합계 **31개 통과**.
JSONL 한 줄/호출, 기존 내용 보존 append, 각 줄 독립 JSON, Unicode/개행 이스케이프,
실제 UTF-8 응답 크기와 메타정보 일치, 오류 응답 기록, 환경변수/설정 우선순위,
쓰기 실패 및 경고 전달 실패 시 반환값 보존, 다른 파일/불완전한 로그/DB hard link 보호를 검증했다.

LM Studio 0.4.24 설치본 갱신 후 전용 채팅에서 일반 문자열 `file`로 네 Tool을 각각 한 번 호출했다.
기존 대화의 대기 중 호출은 승인하지 않았다. 전용 채팅의 설정:

```text
SHERPA_RUN_ID=smoke_20260919_jsonl_01
SHERPA_LOG_DIR=C:\Users\subak\Desktop\AntiForensic\dfir_sherpa_plugins\outputs\tool-logs
```

실제 파일: `outputs/tool-logs/smoke_20260919_jsonl_01_tools.jsonl`, **4줄 / 1,049 bytes**.

| Tool | 성공 | elapsed_ms | output_bytes | returned |
|---|---|---:|---:|---:|
| dataset_overview | true | 95.909 | 623 | 0 |
| search_records | true | 2244.331 | 3400 | 8 |
| get_record | true | 5.349 | 1503 | 1 |
| get_context | true | 9.035 | 2495 | 4 |

첫 번째 실제 JSONL 줄:

```jsonl
{"run_id":"smoke_20260919_jsonl_01","timestamp":"2026-09-19T08:55:17.470Z","tool":"dataset_overview","elapsed_ms":95.909,"returned":0,"output_bytes":623,"success":true,"total_records":487654}
```

`scripts/verify_lmstudio_smoke.mjs`의 `--jsonl`/`--run-id` 옵션으로 네 로그를 실제 LM Studio
Tool 요청/응답 및 성공 이벤트와 대조했다. 허용 필드만 존재하며 실제 응답의 시간/크기/건수/ID 목록과 일치한다.
`--compare-conversation`으로 계측 전 smoke 대화와 비교한 결과 **elapsed_ms 외 반환 JSON 전체가 동일**했다.
본문을 비교에 사용하되 보고서에는 복사하지 않는다.

실행한 검증 명령:

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" scripts/verify_lmstudio_smoke.mjs --db outputs/B5.sqlite --conversation "$env:USERPROFILE/.lmstudio/conversations/1789807677590.conversation.json" --baseline outputs/instrumentation-smoke-baseline.json --report outputs/instrumentation-smoke-B5.json --jsonl outputs/tool-logs/smoke_20260919_jsonl_01_tools.jsonl --run-id smoke_20260919_jsonl_01 --compare-conversation "$env:USERPROFILE/.lmstudio/conversations/1789803555326.conversation.json"
```

보고서: `outputs/instrumentation-smoke-B5.json`, 기준 snapshot: `outputs/instrumentation-smoke-baseline.json`.
DB SHA-256/크기/mtime 불변, journal/WAL/SHM 생성 없음:

```text
fbb57ebe05a709bca4800ad823b9524dc955d8521213b1d01d66b2396c080a42
```

retrieval 모듈 3개는 수정 전후 SHA-256이 동일하다. 본실험과 최종 분석 JSON 저장은 수행하지 않았다.
