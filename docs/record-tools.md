# get_record / get_context

두 Tool은 채팅별 `Canonical timeline DB` 설정을 사용합니다.
현재 기준은 `outputs/B5.sqlite`의 `timeline`과 SQLite `rowid`입니다.
DB 경로, SQL, 컬럼 이름은 모델 입력으로 받지 않습니다.
`search_records` 구현과 기존 benchmark 결과는 변경하지 않았습니다.

## 입력 스키마

```typescript
get_record({ line_id: string })
get_context({ line_id: string, before?: number, after?: number })
```

line_id는 비어 있지 않은 최대 256 UTF-16 code unit 문자열이며 NUL은 허용하지 않습니다.
대소문자·공백·문자열 전체를 그대로 비교합니다. 와일드카드, 부분 ID, SQL이 아닙니다.
before/after는 각각 기본 3, 정수 0~5이며 상한을 넘으면 `INVALID_ARGUMENT`입니다.
범위를 자동으로 바꾸거나 다른 DB로 대체하지 않습니다.

## get_record 출력 스키마

```typescript
{
  ok: true,
  found: true,
  returned: 1,
  rowid: string, // 64-bit 정밀도를 유지하는 십진 문자열
  record: {
    line_id: string, timestamp: string, source: string, event_type: string,
    subject: string, detail: string, payload: string, source_file: string, raw_ref: string
  },
  truncated: boolean, // 필드 중 하나라도 잘렸는가
  field_status: {
    [각 원본 필드명]: {
      truncated: boolean,
      original_bytes: number, // 원본 필드 UTF-8 bytes
      returned_bytes: number  // 반환 문자열 UTF-8 bytes (JSON escaping 전)
    }
  },
  elapsed_ms: number
}
```

9개 필드는 항상 반환하며, 빈 문자열도 그대로 보존합니다. 길이가 넘으면 **원문의 접두부**를
반환하고 잘림 여부를 반드시 표시합니다. 생략 부호를 원문에 붙이지 않습니다.
`truncated: false`인 필드는 완전한 값입니다. 잘린 JSON payload는 완전한 JSON이 아닐 수 있습니다.

각 필드의 상한은 **따옴표·이스케이프를 포함한 JSON 문자열의 UTF-8 bytes**입니다.

| 필드 | JSON byte 상한 |
|---|---:|
| line_id | 1,538 |
| timestamp / source | 각각 256 |
| event_type | 512 |
| subject | 2,048 |
| detail / payload | 각각 6,144 |
| source_file / raw_ref | 각각 1,024 |

전체 compact JSON 응답 상한은 **24,576 bytes**입니다. 예상하지 못한 envelope 초과는
`OUTPUT_LIMIT` 오류로 처리하며 완전한 원문처럼 반환하지 않습니다.

SQLite에서 BLOB byte 길이와 제한된 prefix만 읽고 UTF-8 문자 경계를 맞춰 디코딩합니다.
큰 필드 전체를 JS로 전송하지 않습니다. UTF-8 BOM, 필드 내부 NUL, CR/LF, 한글·이모지를
원문 값으로 보존하며 잘못된 UTF-8은 대체 문자를 삽입하지 않고 오류로 처리합니다.

## get_context 출력 스키마

```typescript
{
  ok: true,
  found: true,
  returned: number,
  before_requested: number, after_requested: number,
  before_returned: number, after_returned: number,
  target_index: number, // records 배열에서 대상 레코드의 0-based 위치
  ordering: "rowid_ascending",
  records: Array<{
    rowid: string,
    is_target: boolean,
    line_id: string, timestamp: string, source: string,
    event_type: string, subject: string,
    snippet: string,
    snippet_field: "detail" | "payload" | "subject",
    field_truncated: {
      line_id: boolean, timestamp: boolean, source: boolean,
      event_type: boolean, subject: boolean, snippet: boolean
    }
  }>,
  elapsed_ms: number
}
```

해당 ID의 rowid를 구한 다음, 작은 rowid 쪽에서 가장 가까운 before개와 큰 rowid 쪽에서
가장 가까운 after개를 읽습니다. rowid에 결번이 있어도 인접 **레코드 수**를 기준으로 합니다.
반환 순서는 rowid 오름차순이며 timestamp나 Line ID의 숫자 부분을 기준으로 하지 않습니다.

기본 최대 7건, 명시적으로 before=5/after=5를 지정하면 최대 11건입니다.
첫/마지막 레코드에서는 실제로 존재하는 만큼만 반환하며 before=after=0이면 대상 한 건입니다.

snippet은 비어 있지 않은 detail → payload → subject 순으로 선택한 필드의 앞부분입니다.
최대 **180 Unicode code points**이며 동시에 JSON 문자열 640 bytes 상한을 적용합니다.
line_id/timestamp/source/event_type/subject의 JSON 문자열 byte 상한은 각각
256/96/96/128/384입니다. 각 필드의 잘림 여부는 `field_truncated`에 항상 표시합니다.
context 응답 전체에도 **24,576 bytes** 상한이 있습니다.
여러 행의 detail/payload 전체 필드는 반환하지 않습니다. 자세한 조회는 `get_record`를 사용합니다.

## 실패 스키마

```typescript
{
  ok: false,
  returned: 0,
  error: "NOT_FOUND" | "INVALID_ARGUMENT" | "DB_NOT_CONFIGURED" |
         "INVALID_SCHEMA" | "INVALID_TEXT" | "DB_READ_FAILED" | "OUTPUT_LIMIT",
  message: string,
  found?: false, // NOT_FOUND일 때만
  elapsed_ms: number
}
```

## 원본 보호와 로그

`readOnly: true`, `query_only=ON`, `trusted_schema=OFF`, `temp_store=MEMORY`로 연결합니다.
모든 조회는 읽기 트랜잭션 안에서 수행하며 값은 바인딩합니다. DB 쓰기, 파일 속성 변경,
schema/FTS 변경, create/edit/delete Tool은 없습니다. 이 문서의 구현 단계에서는 설치본을 갱신하지 않았습니다.
후속 실제 설치·호출 검증은 [smoke test 안내](overview-smoke.md)를 참고하세요.

런타임 자체 로그는 stderr의 JSON 한 줄이며 다음 네 항목만 기록합니다.

```typescript
{ tool: "get_record" | "get_context", line_id: string | null, returned: number, elapsed_ms: number }
```

로그 파일을 만들지 않습니다. 원문·snippet·SQL·DB 경로·스택은 로그에 넣지 않습니다.
잘못된 타입 또는 256자를 넘는 입력 ID는 로그에서 null로 표시합니다.
elapsed_ms는 검증·연결·조회·출력 제한·연결 종료 시간을 포함하며 모델 추론과 로그 전송 시간은 제외합니다.

## 검증 재현

프로젝트 루트에서 실행합니다. 출력 보고서는 새 경로여야 합니다.

```powershell
$nodeExe = "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe"
& $nodeExe --test tests/record_tools.test.mjs
& $nodeExe scripts/verify_record_tools.mjs --fixture --report outputs/record-tools-fixture.json
& $nodeExe scripts/verify_record_tools.mjs --db outputs/B5.sqlite --report outputs/record-tools-B5.json
```

번들 Tool 등록·호출 검증은 [search 문서](search.md)의 빌드 명령 후
`node --test tests/plugin_contract.test.mjs`로 실행합니다.

신규 단위 테스트 11개, 기존 search 테스트 10개, 번들 계약 테스트 1개를 통과했습니다.
fixture/B5 기능 검증은 각각 14개 케이스 × 6회(총 84회)를 수행했습니다.
ID는 첫·중간·마지막 저장 순서와 전체 필드 byte 크기로 선정하며, 정답이나 분석 키워드를 사용하지 않습니다.
독립 SQL 조회와 필드 값·접두부·잘림 표시·출력 순서·건수를 비교했습니다.
부재 ID, before/after 상한, 64-bit rowid 및 결번, 큰 제어문자/Unicode 필드도 검증했습니다.

## B5 실측 (2026-09-19)

캐시가 준비된 상태에서 직접 Tool 함수를 측정했습니다. 각 케이스 최초 1회와 추가 5회를
기록했습니다. 아래 p95는 추가 5회의 nearest-rank 값(이 표본에서는 최댓값)입니다.
장기 p95 또는 cold-disk 상한으로 해석하지 않습니다. 모델 호출은 하지 않았습니다.

| Tool / 케이스 | p50(ms) | p95(ms) | 최대 output bytes |
|---|---:|---:|---:|
| get_record 첫 레코드 | 0.691 | 1.239 | 1,503 |
| get_record 중간 레코드 | 0.642 | 2.020 | 1,380 |
| get_record 마지막 레코드 | 0.576 | 0.661 | 1,510 |
| get_record 원본 byte 크기 최대 레코드 | 2.370 | 2.644 | 7,244 |
| get_context 첫 레코드 | 1.315 | 1.490 | 2,495 |
| get_context 중간 레코드 | 1.742 | 2.042 | 4,427 |
| get_context 마지막 레코드 | 1.701 | 2.248 | 2,484 |
| get_context 큰 레코드 주변 11건 | 2.504 | 3.955 | 6,161 |
| get_context 중간 주변 11건 | 3.042 | 3.168 | 6,809 |

실측 최대치는 테스트한 케이스들의 최대값이며, B5의 모든 가능한 context를 전수 조회한 최대값은 아닙니다.
DB는 487,654행 / 403,509,248 bytes이며 실행 전후 크기·수정 시각·SHA-256이 동일했습니다.
SQLite journal/WAL/SHM 파일도 새로 생성되지 않았습니다.

```text
fbb57ebe05a709bca4800ad823b9524dc955d8521213b1d01d66b2396c080a42
```

상세 보고서: `outputs/record-tools-fixture.json`, `outputs/record-tools-B5.json`.
