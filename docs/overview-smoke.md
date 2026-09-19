# dataset_overview와 LM Studio smoke test

정식 provider는 `dataset_overview`, `search_records`, `get_record`, `get_context`만 노출한다.
`sherpa_ping`은 개발용 별도 모듈에 보존하고 provider에서 제외했다.
기존 검색/레코드 구현과 이전 benchmark 결과는 변경하지 않는다.

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
자체 로그는 `{tool,line_id:null,returned:0,elapsed_ms}`뿐이다.
`get_record`의 기존 24,576-byte 상한은 유지한다.

## 설치 및 실제 채팅 검증

프로젝트 폴더에서 실행:

```powershell
& "$env:USERPROFILE\.lmstudio\bin\lms.exe" dev --install --yes
```

LM Studio에서 새 채팅을 만들고 `local/dfir-sherpa`만 켠다.
Integrations에서 플러그인을 펼쳐 `Canonical timeline DB`에 아래 실험 설정값을 입력한다.
이 경로는 코드 기본값이 아니다.

```text
C:\Users\subak\Desktop\AntiForensic\dfir_sherpa_plugins\outputs\B5.sqlite
```

Tools 목록에 네 Tool만 있는지 확인한다. 다음 순서로 각 1회만 호출한다.

1. `dataset_overview {}`
2. `search_records {"query":"file"}` (기본 limit)
3. 그 결과의 위치만 기준으로 선택한 완전한 line_id를 `get_record`로 조회
4. 같은 line_id를 기본 before/after로 `get_context` 조회

호출 결과 내용은 분석하거나 재검색하지 않는다. 일반 응답 텍스트가 아닌 실제 Tool 결과를 검증한다.
반환 JSON의 UTF-8 byte 수, `elapsed_ms`, 전후 DB SHA-256/크기/mtime 및 SQLite 부속 파일을 확인한다.
설정값은 채팅별이므로 새 분석 채팅에서도 확인해야 한다.

## 로컬 검증

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" --test tests/dataset_overview.test.mjs tests/search_records.test.mjs tests/record_tools.test.mjs
```

25개 단위 테스트 통과. 번들 연결 테스트도 별도로 통과하여 합계 26개.
overview는 fixture의 시간 순서와 저장 순서가 다른 경우, 빈 데이터셋, 오류 인자,
없는 DB/틀린 스키마, 긴 시간값, 2 KiB 상한과 원본 hash/mtime/부속 파일 불변을 검증한다.

## 실제 채팅 증거 검증 스크립트

`scripts/verify_lmstudio_smoke.mjs`는 DB를 읽어서 hash를 계산하고, LM Studio가 저장한 채팅 JSON을
읽어 실제 `toolCallRequest` / `toolCallResult` / `toolCallSucceeded`를 연결한다.
모델의 일반 텍스트 답변은 성공 증거로 사용하지 않는다. 실제 prediction config의 Tool schema도 검증한다.
보고서에는 overview와 스키마 및 크기/시간/상태만 남기고 레코드 본문이나 선택된 Line ID는 복사하지 않는다.

호출 전 snapshot:

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" scripts/verify_lmstudio_smoke.mjs --db outputs/B5.sqlite --snapshot --report outputs/lmstudio-smoke-baseline.json
```

네 실제 호출 후, 해당 smoke 채팅 파일 경로를 `$smokeChat`에 지정하고 검증:

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" scripts/verify_lmstudio_smoke.mjs --db outputs/B5.sqlite --conversation $smokeChat --baseline outputs/lmstudio-smoke-baseline.json --report outputs/lmstudio-smoke-B5.json
```

기존 파일을 덮어쓰지 않으므로 재검증 시 새 보고서 이름을 사용한다.

## 실제 smoke 결과 (2026-09-19)

- LM Studio GUI 0.4.24, `qwen/qwen3.5-9b`, context 131072.
- `lms dev --install --yes`: `Successfully installed local/dfir-sherpa.`
- 설치본과 프로젝트의 src 파일 7개 SHA-256 일치.
- 새 채팅에서 이 플러그인만 활성화하고 DB 경로를 설정했다.
- 모델 입력 prediction config와 실제 input log에 분석용 네 Tool만 있었다. 각 schema의 인자 제한도 검증했다.
- 각 Tool을 순차적으로 한 번씩 호출했다. 일반 문자열 `file` 검색, 결과 위치로 고른 ID,
  같은 ID의 context를 사용했으며 본문 분석이나 정답 검증은 하지 않았다.
- SDK 직접 pluginTools 호출은 앱의 plugins.use 권한 제한으로 사용할 수 없어,
  실제 네이티브 채팅에서 호출하고 저장된 Tool 이벤트로 검증했다. 권한 설정은 변경하지 않았다.

| Tool | 성공 | elapsed_ms | LM Studio Tool 시간(ms) | 반환 JSON UTF-8 bytes | 레코드 수 |
|---|---|---:|---:|---:|---:|
| dataset_overview | 예 | 75.024 | 200 | 623 | 0 (메타정보만) |
| search_records | 예 | 2716.538 | 2854 | 3400 | 8 |
| get_record | 예 | 19.696 | 57 | 1504 | 1 |
| get_context | 예 | 23.627 | 33 | 2496 | 4 (데이터셋 경계) |

단일 smoke 측정으로 모델 추론/승인 대기를 제외한 시간이다. 이전 독립 benchmark를 대체하지 않는다.
이번 smoke의 get_record output은 1,504 bytes로 24,576-byte 상한 안에 있었다.
네 결과를 확인한 뒤 추가 모델 생성을 중지했다. B5 본실험은 수행하지 않았다.

overview 실제 출력 (아래는 가독성을 위한 줄바꿈, 실제 compact JSON **623 bytes**):

```json
{
  "ok": true,
  "dataset": "B5.sqlite",
  "total_records": 487654,
  "available_fields": ["line_id", "timestamp", "source", "event_type", "subject", "detail", "payload", "source_file", "raw_ref"],
  "first_timestamp": "2001-01-01T00:00:00.000Z",
  "last_timestamp": "2026-08-31T21:17:29.208Z",
  "timestamp_order": "text_min_max_nonempty",
  "distinct_source_count": 96,
  "supported_tools": {
    "dataset_overview": "Read dataset metadata only.",
    "search_records": "Count matches and return bounded coverage samples.",
    "get_record": "Read one exact line_id with explicit field truncation.",
    "get_context": "Read compact neighbors in stored rowid order."
  },
  "elapsed_ms": 75.024
}
```

DB 크기 403,509,248 bytes, 전후 SHA-256/mtime/크기와 journal/WAL/SHM 상태 불변:

```text
fbb57ebe05a709bca4800ad823b9524dc955d8521213b1d01d66b2396c080a42
```

증거: `outputs/lmstudio-smoke-B5.json`, `outputs/lmstudio-smoke-baseline.json`,
`outputs/lmstudio-smoke-schemas.json`. 레코드 본문은 보고서에 복사하지 않았다.
