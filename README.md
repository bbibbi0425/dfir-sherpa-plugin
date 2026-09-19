# DFIR Sherpa

Windows / LM Studio용 네이티브 플러그인입니다.
정식 분석 환경에는 `dataset_overview`, `search_records`, `get_record`, `get_context` 네 Tool만 등록합니다.
연구 기준 DB는 팀원이 생성한 `outputs/B5.sqlite`이며, `timeline`과 SQLite `rowid`를 사용합니다.
DB 경로는 플러그인의 채팅별 `Canonical timeline DB` 설정으로 지정합니다.
경로를 코드에 고정하거나 다른 DB로 자동 대체하지 않습니다.
검색 구현·실행·성능 결과는 [search_records 안내](docs/search.md)를 참고하세요.
개별 레코드와 주변 문맥 조회는 [get_record / get_context 안내](docs/record-tools.md)를 참고하세요.
최소 메타정보와 설치 검증은 [dataset_overview / smoke test 안내](docs/overview-smoke.md)를 참고하세요.
실험별 append-only Tool 호출 기록은 [JSONL 계측 안내](docs/instrumentation.md)를 참고하세요.

`sherpa_ping`은 `src/developmentTools.ts`에 기존 동작을 보존하지만 정식 provider에서 노출하지 않습니다. 인자는 없습니다 (`{}`).

반환값은 항상 다음 44바이트 ASCII 문자열입니다.

```json
{"ok":true,"plugin":"dfir-sherpa","stage":1}
```

`sherpa_ping`은 파일, 네트워크, 셸, 데이터베이스에 접근하지 않습니다.
조회 Tool들은 설정된 canonical DB만 읽기 전용으로 조회합니다.
개발·설치 과정에서 생기는 소스/의존성/빌드 파일은 Tool의 기능과 별개입니다.

## 프로젝트 구조

```text
manifest.json         LM Studio 플러그인 식별자: local/dfir-sherpa
package.json          SDK 의존성과 개발 명령
package-lock.json     의존성 잠금 파일
tsconfig.json         TypeScript 설정
src/index.ts          Tools Provider 등록
src/toolsProvider.ts  정식 분석용 네 Tool 등록
src/developmentTools.ts 비노출 개발용 ping
src/config.ts         채팅별 canonical DB 경로 설정
src/datasetOverview.mjs 본문 없는 최소 메타정보, JSON 2 KiB 상한
src/searchRecords.mjs 읽기 전용 검색 및 제한된 coverage sampling
src/recordTools.mjs   개별 레코드 및 compact 주변 문맥 조회
```

## 로컬 설치 (PowerShell)

LM Studio를 실행한 다음 프로젝트 폴더에서 실행합니다.

```powershell
Set-Location 'C:\Users\subak\Desktop\AntiForensic\dfir_sherpa_plugins'
lms dev --install
```

LM Studio에 포함된 도구가 의존성 설치와 빌드를 수행합니다.
최초 설치에는 패키지 다운로드를 위한 인터넷 연결이 필요할 수 있습니다.
`lms`가 인식되지 않으면 다음 절대 경로 명령을 사용합니다.

```powershell
& "$env:USERPROFILE\.lmstudio\bin\lms.exe" dev --install
```

개발 중 자동 재빌드가 필요할 때는 같은 폴더에서 `lms dev`를 실행하고
터미널을 유지합니다. 종료는 `Ctrl+C`입니다.
설치된 버전을 갱신할 때는 `lms dev --install`을 다시 실행합니다.
Hub 공개 업로드는 필요하지 않습니다.

## LM Studio에서 호출 확인 (1단계 이력)

현재 네 Tool의 설치 및 호출 방법은 [smoke test 안내](docs/overview-smoke.md)를 사용하세요.
아래 ping 호출 절차는 이전 설치본의 검증 이력입니다.

1. 새 채팅을 열고 Qwen3.5-9B Q4_K_M을 선택합니다.
2. 모델 로드 설정의 Context Length를 `131072`로 설정합니다.
3. 채팅의 Integrations/플러그인 메뉴에서 `local/dfir-sherpa`를 활성화합니다.
4. 다음 메시지를 보냅니다.

   > sherpa_ping 도구를 인자 없이 정확히 한 번 호출하고, 반환값을 그대로 보여줘.

5. 도구 실행 확인 창이 나타나면 해당 호출을 허용합니다.
6. **실제 Tool 호출 항목**에서 이름 `sherpa_ping`, 인자 `{}`, 위 JSON 반환값을 확인합니다.
   모델이 일반 답변으로 JSON을 작성한 것만으로는 성공으로 판정하지 않습니다.

플러그인이 보이지 않으면 설치 명령의 성공 여부를 확인하고 새 채팅을 열거나
LM Studio를 다시 실행합니다. 호출 없이 답만 나오면 플러그인 활성화 여부를 확인합니다.

## 1단계 실제 검증 결과 (2026-09-19, 이력)

- `lms dev --install`: `Successfully installed local/dfir-sherpa.` 확인.
- LM Studio GUI 버전: `0.4.24`.
- 로컬 모델: `Qwen3.5-9B-Q4_K_M.gguf`, 식별자 `qwen/qwen3.5-9b`.
- `lms ps`와 채팅 화면에서 Context Length `131072` 확인.
- 새 채팅에서 `dfir-sherpa`만 활성화하고 위 테스트 메시지를 전송.
- 실제 `sherpa_ping` 호출 상세의 `Arguments: {}` 확인.
- 실제 `Result` 문자열이 `{"ok":true,"plugin":"dfir-sherpa","stage":1}`과 일치함을 확인.
  UI는 문자열을 JSON으로 표시하므로 바깥쪽 따옴표와 이스케이프가 보일 수 있습니다.
- 프로젝트와 설치본의 `src/toolsProvider.ts` SHA-256이 일치함을 확인.

1단계 완료. 후속 데이터베이스·검색 구현은 진행하지 않았습니다.

## 1단계의 범위 (이력)

- SQLite, CSV 로딩, 실제 포렌식 검색은 아직 구현하지 않았습니다.
- `dataset_overview`, `search_records`, `get_record`, `get_context`는 후속 단계입니다.
- 개발·파일럿 데이터는 분석하거나 코드에 포함하지 않습니다.
- 데이터셋별 정답, 특정 레코드 식별자, 탐지 키워드에 의존하지 않습니다.
- 테스트 Tool의 실제 호출 성공을 확인하면 1단계를 종료합니다.

## 2단계: CSV → SQLite 빌드 (이력)

`scripts/build_timeline_db.py`는 모델 Tool과 분리된 오프라인 빌드 스크립트입니다.
원본 9개 컬럼과 실제 행 위치를 저장하고 일반 인덱스·FTS5를 생성합니다.
전체 행 비교와 무작위 표본 검증을 통과한 DB만 게시하며 읽기 전용 속성을 설정합니다.
실행 명령, 행 번호의 의미, 실패 조건은 [빌드 안내](docs/import.md)를 참고하세요.
2단계에서 만든 `B5_reference.sqlite`는 비교용 파생 DB입니다.
현재 검색은 이 DB를 사용하지 않으며 `B5.sqlite`에 인덱스·테이블을 생성하지 않습니다.

## 3단계: search_records 구현 및 benchmark (이력)

기본 8건, 최대 10건을 반환하며 snippet은 최대 300 Unicode 문자입니다.
전체 일치 건수를 계산한 뒤 일치 집합의 `rowid` 순서에서 고르게 떨어진 순위를 선택합니다.
전체 detail/payload, 임의 SQL, 모델이 지정하는 DB 경로는 반환·허용하지 않습니다.
단위 테스트·플러그인 번들 연결 검증·fixture 및 canonical DB benchmark를 완료했습니다.
이번 단계에서는 설치된 플러그인을 갱신하거나 모델을 통한 검색 호출을 실행하지 않았습니다.
기존 설치본의 `sherpa_ping`은 유지됩니다.

## 공식 참고 문서

- [LM Studio Plugins](https://lmstudio.ai/docs/typescript/plugins)
- [Tools Provider 등록](https://lmstudio.ai/docs/typescript/plugins/tools-provider/single-tool)
- [lms dev 및 로컬 설치](https://lmstudio.ai/docs/cli/develop-and-publish/dev)
