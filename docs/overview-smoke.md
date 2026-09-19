# dataset_overview와 LM Studio smoke test

`dataset_overview`는 레코드 본문을 읽어보지 않고도 데이터 규모와 구조를 확인하기 위한 Tool이다.
정식 provider는 `dataset_overview`, `search_records`, `get_record`, `get_context` 네 Tool만 노출한다.
개발용 `sherpa_ping`은 별도 모듈에 보존되며 정식 provider에는 등록되지 않는다.

## overview 계약

입력은 `{}`. 모델이 SQL, 파일 경로, 필터를 넘길 수 없다.
`Canonical timeline DB` 플러그인 설정의 절대 경로만 사용한다.
DB는 `readOnly:true`, `query_only=ON`, 확장 로딩 비활성화 및 읽기 트랜잭션으로 연다.
원본 DB에 인덱스, FTS, 메타데이터를 만들거나 저장하지 않는다.

반환 필드:

- `ok`, `dataset` (DB 파일명, 매우 길면 파일명에서 파생한 식별자)
- `total_records`, `available_fields` (지원하는 원본 9개 컬럼)
- `first_timestamp`, `last_timestamp`: 비어 있지 않은 timestamp의 텍스트 MIN/MAX.
  `timestamp_order:"text_min_max_nonempty"`로 의미를 명시한다. rowid 양 끝의 시간이 아니며,
  다른 표기법/시간대를 변환하지 않는다. 빈 데이터셋/빈 시간만 있으면 null.
- `distinct_source_count`: `COUNT(DISTINCT source)`; NULL 제외, 빈 문자열 포함.
- `supported_tools`: 네 Tool 이름과 짧은 사용 목적
- `elapsed_ms`: DB 열기, 조회, 닫기를 포함한 직접 실행시간. 모델 추론/사용자 승인 대기 제외.

레코드 본문, 예시, source 이름 목록은 반환하지 않는다. UTF-8 compact JSON 상한은 **2,048 bytes**.
비정상적으로 긴 timestamp는 완전한 시간처럼 잘라서 표시하지 않고 `INVALID_METADATA`로 실패한다.
잘못된 인자/설정/스키마/DB 읽기는 작은 오류 JSON을 반환한다.
기본 stderr 로그는 `{tool,line_id:null,returned:0,elapsed_ms}` 형식이다.
선택적으로 JSONL 파일 기록을 활성화하면 `total_records`, `output_bytes` 등도 기록한다. [계측 안내](instrumentation.md)를 참고하세요.

## 설치와 설정

LM Studio를 실행하고 프로젝트 루트에서 설치한다.

```powershell
& "$env:USERPROFILE\.lmstudio\bin\lms.exe" dev --install
```

새 채팅에서 `local/dfir-sherpa`만 활성화하고 모든 분석 Tool을 켠다.
Integrations의 **Canonical timeline DB**에 테스트할 DB의 절대 경로를 지정한다.
예시 경로는 `C:\data\timeline.sqlite`이며 코드 기본값이 아니다.
DB 형식은 [README](../README.md#데이터베이스-형식)를 따른다. 설정은 채팅별로 확인해야 한다.
JSONL 기록도 검증하려면 호출 전에 [로그 설정](instrumentation.md)을 지정한다.

## 호출 전 snapshot

Tool 호출 전에 같은 DB의 hash·크기·수정 시각과 SQLite 부속 파일 상태를 저장한다.
예시의 DB 경로를 실제 값으로 바꾸고 프로젝트 루트에서 실행한다.

```powershell
$nodeExe = "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe"
$dbPath = 'C:\data\timeline.sqlite'
New-Item -ItemType Directory -Path .\outputs -Force | Out-Null
& $nodeExe scripts/verify_lmstudio_smoke.mjs --db $dbPath --snapshot --report outputs/smoke-baseline.json
```

## 네 Tool 호출

검증용 새 채팅에서 다음 순서로 각각 한 번만 호출한다.

1. `dataset_overview {}`
2. `search_records {"query":"file"}` — limit은 기본값 사용
3. 검색 결과 중 잘리지 않은 `line_id` 하나로 `get_record` 호출
4. 같은 ID로 `get_context` 호출 — before/after는 기본값 3 사용

검증 스크립트는 위 순서·인자와 정확히 네 호출을 기대한다. `file`은 기능 확인용 일반 문자열이며,
이 절차에는 해당 문자열과 일치하는 기록이 있는 테스트 DB가 필요하다.
검색 결과가 없으면 후속 성공 검증을 진행할 수 없으므로 테스트 DB를 준비해 새 채팅과 snapshot으로 시작한다.
응답 본문의 의미나 정답을 평가하지 않고 실제 Tool 호출 성공 여부만 확인한다.

## 저장된 호출 검증

LM Studio가 저장한 해당 채팅 JSON의 경로를 입력하고, snapshot을 만든 PowerShell 세션에서 실행한다.
이는 모델의 마지막 답변만 따로 저장한 파일이 아니라 Tool 이벤트가 포함된 채팅 파일이어야 한다.

```powershell
$smokeChat = Read-Host '검증할 LM Studio 채팅 JSON의 전체 경로'
& $nodeExe scripts/verify_lmstudio_smoke.mjs --db $dbPath --conversation $smokeChat --baseline outputs/smoke-baseline.json --report outputs/smoke-verification.json
```

`scripts/verify_lmstudio_smoke.mjs`는 `toolCallRequest`, `toolCallResult`, `toolCallSucceeded`를 연결한다.
일반 텍스트 답변은 성공 증거로 사용하지 않으며, 실제 prediction config에 노출된 네 Tool의 schema와 인자 제한도 검증한다.
각 반환 JSON의 UTF-8 크기·실행시간과 DB 불변 여부를 확인한다. overview는 2,048 bytes,
나머지 Tool은 각각 24,576 bytes 상한을 검사한다.

보고서에는 overview, schema, 크기·시간·상태와 로컬 경로가 포함되며 레코드 본문이나 선택된 Line ID는 복사하지 않는다.
실제 채팅 파일과 보고서는 로컬에 보관한다. 기존 보고서를 덮어쓰지 않으므로 재검증에는 새 출력 경로를 사용한다.
JSONL 로그 대조와 이전 채팅 비교는 [계측 안내](instrumentation.md#lm-studio에서-로그-확인)를 참고하세요.

## 단위 테스트

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" --test tests/dataset_overview.test.mjs tests/search_records.test.mjs tests/record_tools.test.mjs
```

overview 테스트는 시간 순서와 저장 순서가 다른 fixture, 빈 데이터셋, 오류 인자,
없는 DB·틀린 스키마, 긴 시간값, 2 KiB 상한과 원본 hash·mtime·부속 파일 불변을 다룬다.
