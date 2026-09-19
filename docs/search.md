# search_records — 읽기 전용 타임라인 검색

설정한 SQLite DB의 `timeline` 테이블과 `rowid`를 사용합니다. 필요한 스키마는 [README](../README.md#데이터베이스-형식)에 정리되어 있습니다.
같은 스키마를 가진 데이터셋에 적용할 수 있으며, FTS나 별도 sidecar 인덱스는 사용하지 않습니다.

## 설정

LM Studio 채팅별 플러그인 설정의 **Canonical timeline DB**에 DB의 절대 경로를 입력합니다. 다음은 예시 경로입니다.

```text
C:\data\timeline.sqlite
```

기본 설정은 빈 값입니다. 누락 시 `DB_NOT_CONFIGURED`를 반환하며 다른 DB를 자동 선택하지 않습니다.
DB 경로는 모델이 전달하는 Tool 인자가 아닙니다. 설치 및 호출 확인은 [smoke test 안내](overview-smoke.md)를 참고하세요.
조회는 LM Studio의 Node.js 내장 `node:sqlite`를 사용합니다.

## 입력

| 인자 | 의미 |
|---|---|
| `query` | 선택. subject/detail/payload 중 하나에 포함되는 리터럴 부분 문자열. 생략/빈 문자열은 필터를 통과한 전체 행 |
| `source` | 선택. 정확히 일치하는 source |
| `event_type` | 선택. 정확히 일치하는 event_type |
| `timestamp_from` | 선택. 저장된 timestamp 문자열의 하한, 포함 |
| `timestamp_to` | 선택. 저장된 timestamp 문자열의 상한, 포함 |
| `limit` | 선택. 기본 8, 정수 1~10. 범위 밖 값은 오류 |

조건은 AND로 결합합니다. 자유 텍스트는 SQL `instr(lower(column), lower(?))`로
세 컬럼을 OR 검색합니다. ASCII 영문은 대소문자를 구분하지 않고, 나머지 Unicode는
SQLite 기본 `lower()`의 동작을 따릅니다(전체 Unicode case folding은 아님).
공백은 제거하지 않습니다. `%`, `_`, 역슬래시, 따옴표는 모두 문자 그대로 검색하며
정규식·와일드카드·임의 SQL을 허용하지 않습니다. 검색 문자열은 256자 이내이며 NUL은 거부합니다.
Tool의 Zod 입력 길이 검사는 JavaScript 문자열 길이(UTF-16 code units) 기준입니다.

source/event_type은 원문 그대로, 대소문자를 구분합니다. timestamp는 저장된 문자열의
정렬 순서로 비교하며 날짜나 시간대로 변환하지 않습니다. 사용 데이터셋의 timestamp
형식을 따라 입력해야 합니다. `from > to` 또는 빈 필터는 오류입니다.

## 반환 및 컨텍스트 제한

반환 항목은 `ok`, `total_matches`, `returned`, `limit`, `truncated`, `sampling`,
`records`, `elapsed_ms`입니다. 각 결과는 다음 필드만 포함합니다.

`rowid`, `line_id`, `timestamp`, `source`, `event_type`, `snippet_field`, `snippet`

- `rowid`는 SQLite 64비트 정밀도를 보존하기 위한 십진 문자열입니다.
- `line_id/timestamp/source/event_type` 표시 상한은 각각 80/48/64/96 Unicode 문자입니다.
  잘린 필드는 `truncated_fields`로 알립니다. rowid는 자르지 않습니다.
- snippet은 최대 300 Unicode code points(생략 부호 포함)입니다.
- query가 있으면 subject → detail → payload 순으로 처음 일치하는 필드의 일치 위치
  주변을 반환합니다. query가 없으면 처음으로 비어 있지 않은 필드의 앞부분을 반환합니다.
- SQLite에서부터 `substr`로 제한된 창만 가져옵니다. 전체 detail/payload를 JS 결과나
  모델 응답에 담지 않습니다. snippet 자체는 해당 필드의 짧은 발췌일 수 있습니다.
- 직렬화된 응답은 추가로 24KiB 상한을 적용합니다. JSON 이스케이프 등으로 커지면
  모든 snippet을 줄이고 `snippets_shortened_for_budget: true`를 표시합니다.
- `elapsed_ms`는 연결·스키마 확인·건수 계산·샘플 선택·발췌·연결 종료·응답 제한 처리까지의
  실제 실행 시간을 기록합니다. 모델 추론·Tool 전송 시간은 포함하지 않습니다.
- 레코드 원문은 신뢰할 수 없는 데이터이며 지시문으로 취급하지 않도록 Tool 설명에 명시합니다.

## Deterministic coverage sampling

전체 일치 건수를 정확히 계산합니다. 그다음 **일치하는 행들만** rowid 오름차순으로
순회하며 선택한 순위의 rowid만 보관합니다. DB 조회는 하나의 읽기 트랜잭션에서 수행합니다.

일치 건수가 N, 반환 건수가 K일 때 0부터 시작하는 선택 순위는 다음과 같습니다.

```text
K = min(N, limit)
K >= 2: floor(i * (N - 1) / (K - 1)), i = 0 .. K-1
K == 1: floor((N - 1) / 2)
K == 0: 빈 결과
```

예를 들어 40건 중 8건이면 1, 6, 12, 17, 23, 28, 34, 40번째 일치를 선택합니다.
rowid에 간격이 있어도 일치 순위에 적용합니다. N≤limit이면 모두 반환합니다.
같은 DB·검색 조건·limit은 같은 결과를 반환하며 임의 난수를 사용하지 않습니다.
이는 rowid 순서상 범위를 고르게 살펴보기 위한 표본이지 관련도 순위나 시간 구간별
대표성, 증거의 중요도를 보장하는 표본은 아닙니다.

## 원본 보호

- `DatabaseSync(..., {readOnly:true, allowExtension:false})`로 파일을 엽니다.
- `PRAGMA query_only=ON`, `trusted_schema=OFF`, `temp_store=MEMORY`를 적용합니다.
- SQL 값은 전부 바인딩합니다. 테이블/컬럼 이름은 고정된 canonical 스키마입니다.
- INSERT/UPDATE/DELETE/DDL, migration, FTS 생성, 원본 파일 chmod를 수행하지 않습니다.
- 없는 DB를 생성하지 않습니다. 잘못된 스키마나 경로는 짧은 오류로 반환합니다.
- benchmark 전후 DB SHA-256·수정 시각과 SQLite journal/WAL/SHM 생성 여부를 확인합니다.

## 호출 로그

기본 stderr 로그에 더해, 플러그인 설정 또는 환경변수로 JSONL 파일 기록을 활성화할 수 있습니다.
검색 조건, 전체 일치 건수, 반환 ID와 응답 크기 등을 기록하며 레코드 본문은 저장하지 않습니다.
설정과 실패 처리 방식은 [JSONL 계측 안내](instrumentation.md)를 참고하세요.

## 테스트와 benchmark

프로젝트 루트 PowerShell에서 실행합니다. DB 경로는 사용할 데이터셋으로 바꾸세요.
보고서는 기존 파일을 덮어쓰지 않으므로 재실행 시 새 파일명을 사용합니다.

```powershell
$nodeExe = "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe"
New-Item -ItemType Directory -Path .\outputs -Force | Out-Null
& $nodeExe --test tests/search_records.test.mjs
& $nodeExe scripts/benchmark_search.mjs --fixture --runs 5 --report outputs/search-benchmark-fixture.json
& $nodeExe scripts/benchmark_search.mjs --db 'C:\data\timeline.sqlite' --runs 5 --report outputs/search-benchmark.json
```

번들 계약 테스트는 플러그인을 로컬 설치한 뒤 다음과 같이 실행할 수 있습니다. 설치본의 의존성 버전이 `package.json`과 일치해야 합니다.

```powershell
$env:NODE_PATH = "$env:USERPROFILE\.lmstudio\extensions\plugins\local\dfir-sherpa\node_modules"
& "$env:USERPROFILE\.lmstudio\.internal\utils\esbuild.exe" src/index.ts --bundle --platform=node --format=cjs --outfile=outputs/plugin-check.cjs
& $nodeExe --test tests/plugin_contract.test.mjs
```

benchmark는 일반 필터, 폭넓은 문자, 고정된 행 순위에서 기계적으로 선택한 토큰/문자열,
일치하지 않는 탐침으로 구성됩니다. 데이터셋별 정답이나 분석 키워드는 사용하지 않습니다.
선택한 표본에 해당 컬럼의 토큰이 없으면 그 토큰 케이스를 생략합니다.
각 케이스는 독립적인 LIKE 기반 조회와 건수·표본 rowid를 비교합니다.
보고서에는 성능·크기·입력 해시 등을 기록하고 검색 결과 본문은 넣지 않습니다.

해시 계산과 검증 조회가 측정보다 앞서 수행되므로 warm-cache 측정으로 해석해야 합니다.
소수 반복의 p95는 장기 지연이나 모든 검색어의 상한을 보장하지 않습니다.
정확도 검증과 성능 기준 통과는 구분되며, 자유 텍스트 검색은 데이터 규모와 검색 조건에 따라 느려질 수 있습니다.
실측 보고서와 데이터셋별 성능 판단은 `outputs/`에 보관합니다.

## 관련 문서

- [개별 기록·주변 문맥 조회](record-tools.md)
- [데이터셋 개요·smoke test](overview-smoke.md)
