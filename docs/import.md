# CSV → SQLite 오프라인 빌드

`scripts/build_timeline_db.py`는 normalized timeline CSV를 검증된 SQLite 파생 저장소로 변환하는 별도 스크립트입니다.
생성하는 `records` 테이블은 플러그인이 조회하는 `timeline` 스키마와 다르므로, **출력 DB를 현재 retrieval Tool에 바로 연결할 수 없습니다.**
플러그인용 DB 형식은 [README](../README.md#데이터베이스-형식)를 참고하세요. 이 빌더는 기존 canonical DB에 실행하지 않습니다.

Python 3.10 이상과 표준 라이브러리만 사용합니다. LM Studio 실행이나 플러그인
재설치는 필요하지 않습니다. 스크립트는 CSV를 읽기 전용으로 열며 기존 출력 파일을
덮어쓰지 않습니다. 출력 디렉터리는 실행 전에 만들어야 합니다.

## 실행

일반적인 Python 환경에서는 프로젝트 루트에서 다음을 실행합니다.

```powershell
python -m unittest discover -s tests -v
New-Item -ItemType Directory -Path .\outputs -Force
python .\scripts\build_timeline_db.py .\tests\fixtures\timeline.csv .\outputs\sample.sqlite
python .\scripts\build_timeline_db.py 'C:\data\timeline.csv' .\outputs\timeline.sqlite
```

입력 인코딩은 기본 `utf-8-sig`로, UTF-8 BOM 유무를 모두 처리합니다.
필요하면 `--encoding`으로 지정합니다. 디코딩 오류는 실패하며 대체 문자로 복구하지 않습니다.
`--samples 32`가 기본값입니다. 행 수가 더 적으면 전부 표본 검증합니다.
재실행하려면 새로운 출력 경로를 지정하세요.

성공 시 stdout에 JSON 보고서를 출력하고 종료 코드는 0입니다.
실패 시 stderr에 오류 JSON을 출력하고 종료 코드 1을 반환합니다.
검증되지 않은 작업 파일은 정리하고 최종 이름으로 게시하지 않습니다.

## 저장 구조와 보존 범위

`records`에는 다음 9개 원본 컬럼을 순서대로 **TEXT NOT NULL**로 저장합니다.

`line_id,timestamp,source,event_type,subject,detail,payload,source_file,raw_ref`

문자열의 공백, 빈 문자열, 선행 0, Unicode, JSON 문자열, 필드 내부의 CR/LF/CRLF를
그대로 보존합니다. 날짜 변환, 공백 제거, JSON 재직렬화, NULL 치환을 하지 않습니다.
CSV 인용부호/구분자 같은 직렬화 문법은 테이블에 복제하지 않으며, 원본 파일은
별도로 보존하고 원본 바이트의 SHA-256으로 식별합니다.

추가 컬럼:

- `record_number`: 헤더 다음부터 1로 시작하는 논리적 데이터 레코드 순서(기본 키).
- `physical_row`: 헤더가 끝난 다음 물리적 줄을 1로 한 **레코드 시작 줄**.
  한 레코드의 인용 필드에 줄바꿈이 있으면 다음 값은 그만큼 건너뜁니다.
  예를 들어 두 번째 레코드가 두 줄을 차지하면 시작 위치는 `1, 2, 4, ...`입니다.
  현재 단일 줄 헤더 CSV의 파일 내 절대 시작 줄 번호는 `physical_row + 1`입니다.

헤더 순서/이름이 다르거나, 필드가 9개가 아니거나, 잘못된 인용/인코딩이 있으면
실패합니다. 비어 있는 물리적 레코드는 조용히 건너뛰지 않고 실패합니다.
헤더만 있는 빈 데이터셋은 0행으로 정상 처리합니다.

일반 인덱스: `line_id`, `timestamp`, `source`, `event_type`.
문자열을 보존하므로 timestamp 인덱스는 저장된 텍스트 기준이며 날짜를 재해석하지 않습니다.

## FTS5

실행 환경에서 임시 메모리 DB로 FTS5 지원 여부를 확인합니다.
가능하면 `records_fts`에 `subject`, `detail`, `payload`의 외부 콘텐츠 인덱스를 만듭니다.
행 연결은 `record_number`를 사용하며 원문은 `records`에 보존됩니다.
기본 `unicode61` 토크나이저를 사용합니다. 검색 인덱스의 토큰은 원문 전체를 대체하지 않습니다.
특정 데이터셋, 정답, 레코드 ID, 도구명, 이벤트 값, 분석 키워드에 의존하지 않습니다.

FTS5 미지원이면 일반 인덱스 DB를 생성하고 보고서에 `fts5_applied: false`를 기록합니다.
FTS 생성 중 다른 오류가 발생하면 빌드 전체가 실패합니다.
FTS5 적용 시 외부 원문과의 일치 여부까지 포함한 `integrity-check`를 수행합니다.

## 자동 검증과 메타데이터

최종 게시 전에 다음을 확인합니다.

- 원본을 다시 읽어 CSV와 SQLite의 데이터 행 수 비교.
- 첫/마지막 `line_id` 비교(빈 데이터셋은 null).
- **모든 행의 9개 원본 값과 두 위치 컬럼을 정확히 비교**.
- 무작위 최대 32개 행을 기본 키로 다시 조회하여 모든 값 비교.
- `line_id` 중복 그룹/추가 행 수 계산. 중복이 있으면 실패하며 중복을 제거하지 않습니다.
- SQLite `integrity_check`, 메타데이터 저장 후 다시 읽어 일치 여부 확인.
- 변환 전후 원본 파일의 크기와 SHA-256 비교.

`metadata` 테이블은 `key`와 JSON으로 인코딩한 `value`로 구성됩니다.
원본 절대 경로·크기·SHA-256, 인코딩, 행 수, 행 위치 정의, SQLite 버전,
FTS5 여부, 생성 시각, 빌드/검증 소요시간, 검증 결과를 저장합니다.
최종 DB 크기와 전체 소요시간은 완료 후 stdout 보고서에 출력합니다.

`build_seconds`는 최초 해시 계산부터 데이터 삽입·인덱스 생성·FTS 검증·커밋까지입니다.
`validation_seconds`는 원본 재독해·전체 비교·표본 조회·두 번째 해시 계산을 포함합니다.
`total_seconds`에는 메타데이터 저장, 마지막 무결성 확인, 게시 과정까지 포함됩니다.

## 읽기 전용 파생 저장소

검증 후에만 최종 DB 이름으로 게시하고 Windows 읽기 전용 파일 속성을 설정합니다.
임시 빌드에는 트랜잭션을 사용하며 WAL 파일을 남기지 않습니다.
원본 CSV와 별개인 파생 저장소이므로, 갱신할 때는 새 DB를 빌드합니다.
파일 속성은 절대적인 접근 통제 수단이 아니므로 후속 retrieval 연결도 반드시
SQLite URI의 `mode=ro`와 `PRAGMA query_only=ON`을 사용해야 합니다.
빌더의 검증 연결은 이미 이 설정을 사용합니다.

DB와 생성 보고서는 Git에서 제외된 `outputs/`에 보관하세요. 보고서와 DB 메타데이터에는 원본 경로와 데이터셋 식별 정보가 포함됩니다.
빌더는 모델 Tool에 등록되어 있지 않으며 조회 중 호출되지 않습니다.
