# DFIR Sherpa

**로컬 LLM이 대용량 포렌식 타임라인을 필요한 만큼 탐색하도록 돕는 LM Studio 플러그인입니다.**

DFIR Sherpa는 안티포렌식 연구를 위해 SQLite 타임라인을 읽기 전용으로 조회합니다. 모델은 데이터셋의 개요를 확인하고, 조건에 맞는 기록을 검색한 뒤, 개별 기록과 주변 문맥을 단계적으로 살펴볼 수 있습니다.

전체 타임라인을 모델 컨텍스트에 넣는 대신 검색 결과 수와 텍스트 길이를 제한합니다. 특정 데이터셋의 정답이나 탐지 키워드에 의존하지 않으며, 동일한 스키마를 가진 데이터베이스에 사용할 수 있습니다.

## 주요 기능

| Tool | 역할 | 반환 범위 |
|---|---|---|
| `dataset_overview` | 데이터 규모, 필드, 시간 범위, source 종류 수 확인 | 레코드 본문 없는 메타정보, 최대 2 KiB |
| `search_records` | 자유 텍스트와 source·event_type·시간 조건으로 검색 | 전체 일치 건수와 기본 8건·최대 10건, snippet 최대 300자 |
| `get_record` | 정확한 `line_id`로 개별 기록 조회 | 원본 9개 필드와 필드별 잘림 표시, 전체 JSON 최대 24 KiB |
| `get_context` | 한 기록의 저장 순서상 앞뒤 문맥 조회 | 기본 앞뒤 3건씩, 대상 포함 최대 7건. 명시적으로 확장하면 최대 11건 |

검색 결과가 많으면 일치 집합의 저장 순서에서 고르게 떨어진 위치를 선택하는 **deterministic coverage sampling**을 사용합니다. 같은 DB와 검색 조건은 같은 표본을 반환합니다. 이 표본은 관련도 순위나 증거의 중요도를 의미하지 않습니다.

각 Tool은 `elapsed_ms`를 반환합니다. 선택적으로 호출 메타정보를 JSONL에 기록해 Tool 사용 과정과 실행시간을 확인할 수 있습니다.

## 시작하기

### 준비 사항

- Windows와 LM Studio. 설치·호출 검증에 사용한 버전은 **0.4.24**입니다.
- LM Studio에서 사용할 Tool 호출 지원 모델
- 아래 스키마를 갖춘 SQLite 데이터베이스

조회 모듈은 LM Studio에 포함된 Node.js의 `node:sqlite`를 사용합니다. 원본 데이터와 실험용 DB는 저장소에 포함하지 않습니다.

### 설치

저장소를 내려받고 LM Studio를 실행한 다음, 프로젝트 루트에서 실행합니다.

```powershell
lms dev --install
```

`lms`가 PATH에 없으면 다음 명령을 사용합니다.

```powershell
& "$env:USERPROFILE\.lmstudio\bin\lms.exe" dev --install
```

설치 과정에서 의존성 설치와 빌드가 수행됩니다. 코드를 갱신한 뒤에도 같은 명령으로 재설치할 수 있습니다.

### DB 연결

1. LM Studio에서 채팅을 열고 모델을 선택합니다.
2. Integrations에서 `local/dfir-sherpa`를 활성화합니다.
3. 플러그인 설정의 **Canonical timeline DB**에 사용할 DB의 절대 경로를 입력합니다. 예: `C:\data\timeline.sqlite`.
4. 위 네 Tool이 목록에 표시되는지 확인합니다.

DB 경로는 채팅별 설정이며 모델의 Tool 인자로 받지 않습니다. 경로를 지정하지 않으면 `DB_NOT_CONFIGURED`를 반환합니다.

### 사용 흐름

1. `dataset_overview`로 데이터 규모와 검색 가능한 필드를 확인합니다.
2. `search_records`로 관심 있는 문자열이나 조건을 검색합니다.
3. 반환된 `line_id`를 `get_record`에 전달해 상세 내용을 확인합니다.
4. 같은 ID를 `get_context`에 전달해 주변 기록을 살펴봅니다.

`get_context`의 순서는 SQLite `rowid` 기준입니다. 시간순 정렬을 의미하지 않습니다. 필드가 잘렸다면 반환된 내용을 완전한 원문으로 해석하지 않아야 합니다.

## 데이터베이스 형식

데이터베이스는 외부에서 준비한 SQLite 파일을 사용합니다. 일반 테이블 `timeline`이 있어야 하며, 다음 9개 컬럼은 `TEXT` 형식이어야 합니다.

```text
line_id, timestamp, source, event_type, subject, detail, payload, source_file, raw_ref
```

`line_id`는 단일 컬럼 기본 키여야 하고 SQLite `rowid`를 사용할 수 있어야 합니다. `timestamp`, `source`, `event_type` 인덱스는 필터 조회에 활용할 수 있습니다.

자유 텍스트 검색은 `subject`, `detail`, `payload`에 대한 리터럴 부분 문자열 검색입니다. FTS는 사용하지 않으며, 검색 성능은 데이터 크기와 조건에 따라 달라집니다. timestamp는 저장된 문자열을 기준으로 비교하고 날짜 형식이나 시간대를 변환하지 않습니다.

## 읽기 전용 조회와 호출 로그

모든 조회는 SQLite 읽기 전용 연결과 `query_only` 설정을 사용합니다. 원본 DB의 데이터·스키마·인덱스를 변경하지 않으며, 모델에는 임의 SQL이나 파일 생성·수정·삭제 Tool을 제공하지 않습니다.

호출 로그가 필요하면 채팅별 플러그인 설정에 다음 값을 지정합니다. 아래 값은 예시입니다.

```text
SHERPA_RUN_ID=example_run_01
SHERPA_LOG_DIR=C:\experiment-logs
```

로그는 `<SHERPA_LOG_DIR>/<SHERPA_RUN_ID>_tools.jsonl`에 호출마다 한 줄씩 추가됩니다. 두 설정은 각각 빈 값이면 같은 이름의 환경변수를 사용하고, 설정과 환경변수가 모두 없으면 파일 로깅을 끕니다.

로그에는 Tool명, 실행시간, 반환 크기·건수, 검색 조건, 요청·반환된 Line ID 등의 메타정보를 기록합니다. 레코드 본문이나 전체 Tool 응답은 저장하지 않습니다. 로그 쓰기가 실패하면 오류를 알리고 조회 결과는 그대로 반환합니다. 최종 assistant 응답의 자동 파일 저장은 제공하지 않습니다.

실험 로그와 내부 메모는 Git에서 제외된 `outputs/` 아래에 보관할 수 있습니다. 설정과 기록 항목은 [JSONL 계측 안내](docs/instrumentation.md)를 참고하세요.

## 개발 및 문서

```text
src/        Tool 구현, 플러그인 설정, 호출 로그
scripts/    benchmark, 호출 검증 스크립트
tests/      합성 fixture와 기능 테스트
docs/       상세 스키마와 실행·검증 안내
```

개발 중 자동 빌드는 프로젝트 루트에서 `lms dev`로 실행합니다. 개발용 `sherpa_ping`은 소스에 보존되어 있지만 정식 Tool 목록에는 등록하지 않습니다.

조회 및 로깅 단위 테스트:

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" --test tests/search_records.test.mjs tests/record_tools.test.mjs tests/dataset_overview.test.mjs tests/tool_logging.test.mjs
```

- [검색 조건·반환 형식·sampling](docs/search.md)
- [개별 기록·주변 문맥 조회](docs/record-tools.md)
- [데이터셋 개요·설치 및 smoke test](docs/overview-smoke.md)
- [Tool 호출 JSONL 계측](docs/instrumentation.md)
