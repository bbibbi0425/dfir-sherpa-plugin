# 개발·수동 복구용 Run 시작과 종료

일반 실험에서는 [더블클릭 launcher](desktop-launcher.md)를 사용합니다. 아래 명령은 개발과 수동 복구용으로 유지하며, 자동 모드와 동시에 실행하지 않습니다.

Windows 로그인 자동 시작은 사용하지 않습니다. LM Studio를 실행하고 플러그인의 DB 경로를 설정한 뒤, 프로젝트 루트에서 시작 명령 한 번으로 Collector와 model log stream을 함께 실행합니다.

```powershell
npm run experiment:start -- --run-id example_run_02
```

명령이 `ready`를 반환한 뒤 **새 LM Studio 채팅**에서 DFIR Sherpa를 사용합니다. 마지막 응답이 끝나면 다음 명령으로 수집을 마무리합니다.

```powershell
npm run experiment:stop -- --run-id example_run_02
```

Node.js/npm이 PATH에 없다면 동일한 명령을 LM Studio 번들 Node.js로 실행할 수 있습니다.

```powershell
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" scripts/experiment.mjs start --run-id example_run_02
& "$env:USERPROFILE\.lmstudio\.internal\utils\node.exe" scripts/experiment.mjs stop --run-id example_run_02
```

플러그인 코드를 갱신한 경우 최초 한 번 `lms dev --install`로 설치본을 갱신해야 합니다. 이후에는 Run마다 플러그인을 다시 설치하거나 환경변수를 입력할 필요가 없습니다.

## 시작 계약

- `outputs/results/<run_id>/`와 `run.json`을 새로 만듭니다. 같은 이름이 있으면 실패하며, 실패한 Run도 재사용하지 않습니다.
- Run마다 숨김 Collector 프로세스를 실행하고, 그 자식 프로세스로 `lms log stream --source model --filter input,output --stats --json`을 실행합니다.
- model stream의 준비 메시지, 프로세스 생존, 첫 수집 루프를 확인한 후에만 성공을 반환합니다. 실행 실패·조기 종료·준비 시간 초과는 비정상 종료 코드와 `start_failed`로 남깁니다.
- `runtime.json`에는 Collector/model logger 각각의 PID, 프로세스 생성 식별값, 상태와 실행 명령을 기록합니다. Collector 중단 시 model logger를 정리하는 IPC 보조 프로세스의 PID도 기록합니다.
- 시작한 자식 프로세스에는 `SHERPA_RUN_ID`와 `SHERPA_LOG_DIR`를 전달합니다. 이미 실행 중인 LM Studio와의 연결에는 아래 상태 파일을 사용합니다.

## 플러그인 연결과 대화 선택

`%USERPROFILE%\.lmstudio\dfir-sherpa\active-experiment.json`은 운영자 명령과 플러그인을 연결하는 로컬 상태 파일입니다. Collector가 Run ID, 결과 경로, PID, heartbeat를 갱신합니다. 플러그인은 파일을 읽기만 하며, 활성 Run ID를 모델에게 보이지 않는 Tool 상태로 전달합니다. Tool 반환 JSON은 그대로입니다.

활성 실험에서는 이 Run ID가 채팅에 남은 예전 `SHERPA_RUN_ID`보다 우선합니다. summary의 유일한 작성자는 Collector이며, 저장된 Tool 응답에서 실행시간·반환 크기·입력 정보를 재구성합니다. 따라서 직접 기록과 재수집으로 같은 호출을 두 번 append하지 않습니다. 수집 시각은 `collector_observation`으로 구분합니다.

한 사용자 계정에서 **한 번에 하나의 실험 Run과 하나의 새 분석 채팅**을 사용합니다. 시작 전에 이미 Sherpa Tool을 사용한 대화는 제외합니다. Run ID를 표시한 새 대화가 둘 이상이면 임의로 고르지 않고 수집 오류와 `unknown`으로 남깁니다. 오래되거나 유효하지 않은 상태 파일은 플러그인 경고로 알리며 조회 결과를 변경하지 않습니다.

기존 always-on Collector가 실행 중이면 먼저 `npm run collector:stop`으로 종료합니다. 실험 모드와 동시에 아카이브를 쓰지 않도록 시작 명령이 이를 검사합니다. 기존 `init / collect --watch` 명령도 유지됩니다.

## 종료와 복구

종료 명령은 해당 Collector에 종료를 요청하고 model stream을 닫은 뒤, 저장된 conversation과 model 이벤트를 다시 수집합니다. LM Studio 앱이나 모델 추론 자체를 종료하지 않습니다. 응답 생성 중에 종료하면 완성된 분석 결과로 취급하지 않습니다.

Collector가 이미 종료됐어도 `experiment:stop`을 실행할 수 있습니다. 남아 있는 model logger는 PID와 프로세스 생성 식별값을 대조한 뒤에만 종료합니다. PID가 다른 프로세스에 재사용됐다면 그 프로세스를 종료하지 않으며 확인 오류를 반환합니다. 대화와 로컬 원본 로그에서 가능한 결과를 복구합니다. 같은 종료 명령을 다시 실행해도 Tool 이벤트는 중복 append하지 않습니다.

`run.json`에는 종료 시각과 `completed`, `interrupted`, `unknown`, `start_failed` 상태를 남깁니다. `completed`는 최종 응답 정상 종료와 모든 대상 Tool 성공이 확인될 때만 사용합니다. 프로세스 종료 상태는 별도로 `runtime.json`에 기록합니다.

```text
outputs/results/<run_id>/
├── run.json
├── runtime.json
├── prompt.txt
├── <run_id>_tools.jsonl
├── tool-events.jsonl
├── conversation.json          대화를 식별한 경우
├── model-response.md
├── model-response.json        응답 원문이 valid JSON인 경우에만
├── model-statistics.json      대화의 genInfo
├── model.log                  연결된 원본 model 이벤트
├── collector.stdout.log
├── collector.stderr.log
├── model-stream.stderr.log
└── .collector/model-events/   수집한 원본 이벤트와 복구 자료
```

`model-response.json`은 envelope가 아니라 유효한 JSON 응답 원문입니다. 코드 펜스 등으로 감싼 문자열은 JSON으로 임의 변환하지 않고 Markdown에 보존하며, 파싱 상태는 manifest에 기록합니다. 대화를 찾지 못하면 빈 응답 파일과 `unknown`을 남기고 대화 복사본을 만들어내지 않습니다.

LM Studio model stream에는 conversation ID가 없으므로 [기존 Collector의 보수적인 연결 규칙](collector.md#모델-로그와-통계)을 유지합니다. 모호한 이벤트는 `model.log`에 섞지 않고 로컬 원본 저장소에 남기며, 누락은 `model_capture`에 표시합니다. `promptTokensCount`, `totalTimeSec`, `timeToFirstTokenSec` 등은 원형 그대로 보존합니다.

## 경로와 무결성

`--results-root`, `--conversation-dir`, `--lms`로 경로를 지정할 수 있습니다. 시작 시 `--db C:\data\timeline.sqlite`를 함께 주면 실험 전 DB 해시를 남기고 플러그인의 DB 설정과 대조합니다. 생략하면 플러그인의 기존 DB 설정을 사용하며 해시 baseline은 첫 대화 감지 시점입니다. 시작 이전 해시로 표시하지 않습니다.

포렌식 DB와 원본 LM Studio conversation은 읽기만 합니다. 결과·런타임 상태는 Git에서 제외된 `outputs/`에 보관하며, 로그인 자동 시작 항목이나 Windows 실행 정책은 변경하지 않습니다.
