# 실행별 결과 보관

이 문서는 개발·수동 복구용 `init` / `collect` 방식을 설명합니다. 일반 실험에는 [더블클릭 launcher](desktop-launcher.md)를 사용합니다. 명시적으로 준비된 수동 Run은 별도로 수집합니다.

`scripts/run_results.mjs`는 실행 전에 결과 폴더를 준비하고, LM Studio가 저장한 대화에서 최종 응답을 수집하는 운영자용 스크립트입니다. 모델 Tool에 등록되지 않으며 retrieval 코드나 반환 구조를 변경하지 않습니다.

기본 저장 위치는 프로젝트 루트 기준 `outputs/results/<run_id>/`입니다. `outputs/`는 Git에서 제외됩니다.

```text
outputs/results/<run_id>/
├── run.json                 실행 상태, 모델·설정, DB 및 결과 파일 해시
├── prompt.txt               준비 시 지정한 프롬프트 파일 원본
├── <run_id>_tools.jsonl      기존 provider가 append하는 Tool 호출 로그
├── model-response.md        선택된 assistant 응답의 최종 텍스트
└── conversation.json        LM Studio 대화 파일의 원본 바이트 복사본
```

`init`은 앞의 세 파일을 만들고, `collect`가 뒤의 두 파일을 추가하며 `run.json`을 갱신합니다. DB는 복사하거나 수정하지 않습니다.

## 1. 실행 폴더 준비

아래 경로와 run ID는 가상 예시입니다. UTF-8 텍스트 파일로 프롬프트를 준비하고 프로젝트 루트에서 실행합니다.

```powershell
$nodeExe = "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe"
& $nodeExe scripts/run_results.mjs init --run-id example_01 --db 'C:\data\timeline.sqlite' --prompt 'C:\experiment-inputs\prompt.txt'
```

명령은 DB 파일과 SQLite 헤더를 읽고 SHA-256·크기·수정 시각·SQLite 부속 파일 상태를 기록합니다. DB 스키마 검증은 기존 retrieval Tool이 담당합니다.

기존 run 폴더를 재사용하거나 파일을 덮어쓰지 않습니다. 매번 새 ID를 사용하세요. ID는 영문·숫자로 시작하는 1~80자의 영문·숫자·`_`·`-`이며 Windows 예약 이름은 거부합니다.

명령이 출력하는 `plugin_settings` 값을 새 LM Studio 채팅에 입력합니다.

| 출력 키 | LM Studio 플러그인 설정 |
|---|---|
| `databasePath` | Canonical timeline DB |
| `SHERPA_RUN_ID` | SHERPA_RUN_ID |
| `SHERPA_LOG_DIR` | SHERPA_LOG_DIR — 생성한 run 폴더의 절대 경로 |

이 수집 흐름에서는 두 로그 값을 **채팅 설정에 직접 지정**합니다. 환경변수만 사용하면 나중에 저장된 대화에서 실행 설정을 대조할 수 없습니다. `init`이 LM Studio 설정을 자동으로 바꾸지는 않습니다.

## 2. 새 채팅에서 실행

한 run에는 **사용자 프롬프트 한 개와 assistant 응답 한 차례**를 사용합니다. assistant 응답 안의 여러 Tool 호출은 모두 포함됩니다.

1. 새 채팅에서 모델과 `local/dfir-sherpa`를 선택합니다.
2. 위 DB·로그 설정을 입력합니다.
3. `prompt.txt`의 텍스트를 그대로 입력하고 실행합니다.

현재 수집기는 텍스트 전용 프롬프트를 지원합니다. 첨부 파일이나 후속 사용자 메시지가 있는 대화는 거부합니다. 프롬프트 비교에서는 UTF-8 BOM과 CRLF/LF 차이만 허용하며, 나머지 공백은 그대로 비교합니다. 시스템 프롬프트는 대화 원본과 `run.json`에 별도로 보존합니다.

Tool 로그는 기존 방식으로 호출 직후 같은 run 폴더에 추가됩니다. Tool을 호출하지 않은 실행에서는 로그 파일이 비어 있습니다.

## 3. 종료 후 수집 또는 자동 대기

대상 채팅 파일은 LM Studio의 사용자 데이터 폴더 아래 `conversations`에서 확인할 수 있습니다. 파일 이름을 추측하지 않고 해당 실행의 파일을 지정하세요. 후보 파일의 수정 시각은 다음 명령으로 볼 수 있습니다.

```powershell
Get-ChildItem "$env:USERPROFILE\.lmstudio\conversations" -Filter '*.conversation.json' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 5 Name, LastWriteTime
```

실행이 끝난 뒤 한 번 수집하려면:

```powershell
$runDir = (Resolve-Path 'outputs/results/example_01').Path
$chatFile = Read-Host '이번 실행의 LM Studio 채팅 JSON 전체 경로'
& $nodeExe scripts/run_results.mjs collect --run-dir $runDir --conversation $chatFile
```

생성 중에 아래 명령을 켜 두면 **종료 상태를 감지한 후 자동 수집**합니다. 이 명령은 모델을 실행하거나 Tool 호출을 승인하지 않습니다.

```powershell
& $nodeExe scripts/run_results.mjs collect --run-dir $runDir --conversation $chatFile --watch --timeout-seconds 7200
```

`--watch`는 기본 1초 간격으로 확인하며, 종료 상태의 대화와 로그가 연속 두 번 동일할 때 수집합니다. 기본 대기 상한은 3,600초입니다. 수집 중 파일이 바뀌면 다시 기다립니다. 대기 시간 초과나 `Ctrl+C`는 결과를 완료 처리하지 않습니다. watcher를 실행하지 않은 상태에서는 자동 수집되지 않습니다.

사용자가 중단했거나 오류가 난 실행도 LM Studio의 종료 이유에 따라 `interrupted` 또는 `failed`로 보관합니다. 승인 대기 등 종료 정보가 없는 실행은 **먼저 LM Studio에서 생성을 중지한 다음** 명시적으로 수집할 수 있습니다.

```powershell
& $nodeExe scripts/run_results.mjs collect --run-dir $runDir --conversation $chatFile --interrupted
```

## 보존 및 검증 기준

- `conversation.json`은 선택되지 않은 메시지 버전을 포함한 대화 파일 전체를 바이트 그대로 복사합니다.
- `model-response.md`는 선택된 assistant 버전에서 마지막 Tool 이벤트 뒤의 일반 텍스트를 이어 붙입니다. 추론 블록, Tool 결과, 구조 토큰은 제외합니다. JSON 응답도 다시 파싱하거나 포맷하지 않습니다.
- 마지막 일반 텍스트가 없으면 빈 응답 파일을 만들고 `response.available: false`를 기록합니다. 이를 완성된 분석 결과로 표시하지 않습니다.
- 모델명, 로드·생성 설정, 생성 통계는 대화에 저장된 값만 보존합니다. 없는 값은 추정하지 않습니다.
- `prepared_at`과 `collected_at`은 준비·수집 시각입니다. 실제 추론 시작·종료 시각을 의미하지 않으며, 추론 통계는 `generation_settings[].stats`로 확인합니다.
- 프롬프트·run ID·DB 경로·로그 디렉터리를 대조합니다. 완료된 대화의 Tool 이름·건수·반환 크기·실행시간과 주요 입력·반환 ID도 JSONL과 비교합니다.
- DB와 부속 파일의 전후 해시·크기·수정 시각을 비교합니다. 차이가 있으면 결과를 보존하되 `integrity: failed`와 종료 코드 1을 반환합니다.
- 중단된 대화에 결과 없는 Tool 요청이나 불완전한 로그가 있으면 그대로 보관하고 불일치를 `tool_log.problems`에 기록합니다. 정상 완료로 간주하지 않습니다.

`status`는 모델 실행 상태이고 `integrity`는 보관한 자료의 일치 여부입니다. 예를 들어 모델 생성은 `completed`여도 DB가 바뀌었다면 `integrity`는 `failed`입니다. 완료된 대화의 로그가 맞지 않으면 수집을 거부하며, watcher는 저장이 마무리될 때까지 기다립니다.

수집 완료 후에는 해당 채팅에서 추가 호출하거나 같은 run ID를 재사용하지 마세요. 기존 logger는 append 방식이므로 추가 호출은 보관한 해시와 달라집니다. 새 실험에는 새 폴더와 새 채팅을 사용합니다.
Tool을 호출한 응답을 재생성하면 이전 호출도 같은 로그에 남아 선택된 응답과 불일치할 수 있습니다. 재생성 실험도 새 run으로 분리하세요.

기존 응답·대화 파일은 덮어쓰지 않으며 동시 수집은 잠금 파일로 막습니다. 디스크 오류나 강제 종료로 일부 파일만 저장되면 성공으로 표시하지 않습니다. `.collect.lock` 또는 부분 결과가 남아 있는 경우 원본을 보존하고 상태를 확인한 뒤 복구해야 합니다.

전체 대화에는 증거 본문, 검색 조건, 개인 경로가 포함될 수 있습니다. 기본 `outputs/results/`를 유지하세요. `--results-root`로 위치를 바꾼 경우 그 위치의 Git 제외 여부는 별도로 관리해야 합니다.

현재 파서는 LM Studio 0.4.24에서 확인한 native conversation 구조를 대상으로 합니다. 다른 형식의 export나 앱 버전에서는 먼저 확인이 필요합니다.

## 테스트

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" --test tests/run_results.test.mjs
```

합성 SQLite fixture와 실제 retrieval 함수로 로그를 생성해 파일 보존, Unicode 응답, 버전 선택, 중단·대기 처리, 잘못된 실행 연결, 로그 불일치, 덮어쓰기 방지와 DB hash 불변을 검증합니다.
