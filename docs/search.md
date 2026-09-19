# search_records — canonical DB 읽기 전용 검색

기준 DB는 `outputs/B5.sqlite`입니다. `timeline` 테이블과 SQLite `rowid`를 사용합니다.
2단계 파생 DB의 `records`, `record_number`, `physical_row`, FTS5에 의존하지 않습니다.
경로는 설정으로 전달하므로 같은 스키마를 가진 다른 데이터셋에도 적용할 수 있습니다.

## 설정과 실행 범위

LM Studio 채팅별 플러그인 설정의 **Canonical timeline DB**에 절대 경로를 입력합니다.
현재 연구 환경의 값:

```text
C:\Users\subak\Desktop\AntiForensic\dfir_sherpa_plugins\outputs\B5.sqlite
```

기본 설정은 빈 값입니다. 누락 시 `DB_NOT_CONFIGURED`를 반환하며 다른 DB를 자동 선택하지 않습니다.
DB 경로는 모델이 전달하는 Tool 인자가 아닙니다. 개발용 `sherpa_ping`은 설정 없이 동작하지만 현재 정식 provider에는 노출하지 않습니다.

아래 설치 상태 설명은 search 구현 단계의 이력입니다. 현재 설치 상태는 [smoke test 안내](overview-smoke.md)를 참고하세요.
당시 단계는 소스 구현·번들 검증·benchmark까지 완료했습니다. 설치본 갱신이나
LM Studio 모델의 실제 `search_records` 호출은 실행하지 않았습니다.
코드를 나중에 로컬 적용할 때는 프로젝트 루트에서 `lms dev --install`로 갱신하고,
채팅의 DB 경로를 설정합니다. 현재 설치된 기존 플러그인은 그대로 유지했습니다.

실측 런타임은 LM Studio의 Node.js `v25.5.0`, SQLite `3.51.2`입니다.
내장 `node:sqlite`를 사용하며 SQLite 네이티브 패키지를 별도로 설치하지 않습니다.
현재 런타임에서 SQLite 실험 기능 경고가 출력되지만 테스트·검색은 정상 실행됩니다.

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

## 테스트와 benchmark 재현

프로젝트 루트 PowerShell에서 실행합니다. 보고서 경로는 기존 파일을 덮어쓰지 않으므로
재실행 시 새 파일명을 사용합니다.

```powershell
$nodeExe = "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe"
& $nodeExe --test .\tests\search_records.test.mjs
& $nodeExe .\scripts\benchmark_search.mjs --fixture --runs 5 --report .\outputs\search-benchmark-fixture.json
& $nodeExe .\scripts\benchmark_search.mjs --db .\outputs\B5.sqlite --runs 5 --report .\outputs\search-benchmark-B5.json
```

플러그인 번들 계약 검증은 SDK와 zod가 설치된 상태에서 다음으로 실행합니다.
현재 환경에서는 기존 설치본의 동일 버전 의존성을 NODE_PATH로 지정해 빌드했습니다.

```powershell
$env:NODE_PATH = "$env:USERPROFILE\.lmstudio\extensions\plugins\local\dfir-sherpa\node_modules"
& "$env:USERPROFILE\.lmstudio\.internal\utils\esbuild.exe" src/index.ts --bundle --platform=node --format=cjs --outfile=outputs/plugin-check.cjs
& $nodeExe --test .\tests\plugin_contract.test.mjs
```

benchmark는 일반 필터, 폭넓은 문자, 고정된 행 순위에서 기계적으로 선택한 토큰/문자열,
일치하지 않는 탐침으로 구성됩니다. 데이터셋별 정답이나 분석 키워드는 사용하지 않습니다.
선택한 표본에 해당 컬럼의 토큰이 없으면 그 토큰 케이스를 생략합니다.
실제 B5 실행에서는 payload 토큰 케이스가 생략되었으며, payload 검색의 양성 동작은
synthetic fixture에서 확인했습니다. 불일치 탐침은 세 컬럼을 모두 확인합니다.
각 케이스는 독립적인 LIKE 기반 전수 조회와 건수·표본 rowid를 비교합니다.
결과 본문은 출력하지 않고 성능·크기·입력 해시만 보고서에 기록합니다.

## 2026-09-19 실측 결과

40행 fixture와 487,654행 canonical DB에서 각 케이스 최초 측정 1회 및 반복 5회를 실행했습니다.
**원본 해시·표본 후보 선택·검증 조회가 선행된 warm-cache 측정**입니다. cold-disk 성능은
측정하지 않았습니다. 아래 p95는 반복 5회의 nearest-rank 값으로, 이 작은 표본에서는 최댓값입니다.
통계적으로 안정된 장기 p95나 모든 검색어의 지연 상한을 의미하지 않습니다.

환경: Intel Core i7-1355U, 논리 CPU 12개, RAM 약 16GB, Node.js 25.5.0 / SQLite 3.51.2.

| B5 케이스 | 전체 일치 | 반환 | p50(ms) | p95(ms) |
|---|---:|---:|---:|---:|
| 전체 행 | 487,654 | 8 | 953.047 | 963.914 |
| source 필터 | 313,471 | 8 | 287.179 | 429.781 |
| event_type 필터 | 43,234 | 8 | 61.228 | 68.464 |
| timestamp 동일값 범위 | 2 | 2 | 0.812 | 1.346 |
| subject 표본 토큰 | 3,920 | 8 | 2,139.650 | 2,203.981 |
| detail 표본 토큰 | 368 | 8 | 1,916.190 | 2,051.723 |
| 일반 문자, limit=10 | 487,654 | 10 | 1,634.439 | 1,678.064 |
| 리터럴 문자열 | 23 | 8 | 1,323.457 | 1,503.988 |
| 텍스트 + source | 3,103 | 8 | 1,219.662 | 1,605.125 |
| 일치하지 않는 탐침 | 0 | 0 | 1,029.301 | 1,047.392 |

fixture의 자유 텍스트 케이스 p95는 0.980~1.719ms였습니다.
B5에서 응답 JSON의 최대 실측 크기는 2,952 bytes였으며, 487,654건이 일치해도 최대 10건만 반환했습니다.
모든 건수·선택 rowid·결과 반복성·출력 상한 검증이 통과했습니다.
DB SHA-256은 실행 전후 다음 값으로 동일했습니다.

```text
fbb57ebe05a709bca4800ad823b9524dc955d8521213b1d01d66b2396c080a42
```

측정 전에 정한 탐색용 기준은 자유 텍스트 반복 p95≤2,000ms입니다.
**일부 케이스가 기준을 초과했으므로 성능 기준은 전체 통과하지 못했습니다.**
정확도 검증 통과와 성능 기준 통과는 보고서에서 별도 필드로 구분합니다.
FTS 없는 기준 구현과 측정 결과를 여기서 유지합니다. 반복 실험에서 이 지연이 문제가 되면
별도 sidecar FTS의 필요성을 다음 단계에서 검토할 근거가 됩니다. sidecar는 생성하지 않았습니다.

이 문서의 search 구현과 benchmark 결과는 유지합니다. 후속 단계에서 추가한
`get_record`, `get_context`는 [개별/문맥 조회 문서](record-tools.md)를 참고하세요.
최소 메타정보와 실제 설치 검증은 [dataset_overview / smoke test](overview-smoke.md)를 참고하세요.
sidecar FTS는 구현하지 않았습니다.

## 공식 API 참고

- [LM Studio 플러그인 설정](https://lmstudio.ai/docs/typescript/plugins/custom-configuration/config-ts)
- [Node.js SQLite API](https://github.com/nodejs/node/blob/main/doc/api/sqlite.md)
