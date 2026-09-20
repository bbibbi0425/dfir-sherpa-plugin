# 더블클릭으로 실험하기

일반 사용에서는 PowerShell 명령, Run ID, 환경변수, 종료 명령을 입력하지 않습니다. Windows 로그인 자동 시작도 등록하지 않습니다.

1. 프로젝트의 **DFIR-Sherpa-Experiment.cmd** 또는 이 파일의 바탕화면 바로가기를 더블클릭하고 준비 완료 메시지를 확인합니다.
2. 열린 LM Studio에서 **새 채팅**을 만들고 DFIR Sherpa의 **Canonical timeline DB**에 SQLite 절대 경로를 지정한 뒤 실험 Prompt를 입력합니다.
3. 최종 응답이 끝나면 `outputs/results/<run_id>/`에서 결과를 확인합니다. 수집기 종료 명령은 필요하지 않습니다.

처음에는 **setup.cmd**로 플러그인과 바탕화면 바로가기를 설치합니다([설치 안내](setup.md)). DB는 설치 과정에서 선택하지 않습니다. **Canonical timeline DB** 설정은 매 실험의 새 채팅에서 직접 지정하며, 빈 값이면 Tool이 오류를 반환합니다. Run 도중 DB를 바꾸지 마세요. LM Studio 자체의 Tool 실행 확인창은 앱 정책에 따라 표시될 수 있으며, launcher는 보안·승인 설정을 바꾸지 않습니다.

## 실행과 자동 저장

CMD가 Windows Script Host를 통해 Node launcher를 숨김 실행합니다. Collector, model stream, runtime state를 준비하고 LM Studio를 실행합니다. 준비 메시지는 model stream의 준비 신호와 프로세스 상태를 확인한 뒤 표시합니다. 실패 시 오류 대화상자를 표시하므로 검은 터미널 창을 조작할 필요가 없습니다.

이미 실행 중인 자동 Collector가 있으면 재사용합니다. 수집기는 여러 대화를 순서대로 처리하며 다음 Run을 위해 대기합니다. LM Studio가 종료되거나 연결이 끊어지면 재연결을 시도합니다. 재부팅 후에는 launcher를 다시 더블클릭하면 됩니다.

새 conversation에서 네 Sherpa Tool 중 하나의 요청이 저장되면 Run을 만듭니다. 자동 ID는 `run_YYYYMMDD_HHMMSS`이며 같은 초에 생성되면 충돌 방지 접미사를 붙입니다. 이전 채팅의 수동 Run ID나 DB 파일명에서 사건명을 추측하지 않습니다. 같은 conversation의 후속 질문·재생성은 같은 Run을 갱신합니다.

```text
outputs/results/<run_id>/
├── run.json
├── prompt.txt
├── tools-summary.jsonl
├── tool-events.jsonl
├── model.log
├── model-response.md
├── model-response.json
├── conversation.json
└── model-statistics.json
```

summary는 본문 없이 호출·검색 조건·반환 ID·실행시간·반환 크기를 기록합니다. `tool-events.jsonl`에는 Sherpa 요청·결과·상태 원문이 들어가며, 전체 conversation을 별도로 복사합니다. summary는 저장된 응답에서 재구성하므로 시각을 실제 호출 시각으로 가장하지 않고 `collector_observation`으로 표시합니다. 자동 수집이 활성화된 동안 기존 수동 summary 경로에 중복 기록하지 않습니다.

`model-response.md`는 마지막 응답의 일반 텍스트입니다. `model-response.json`은 `{status, stop_reason, text, parsed_json, parse_error}` 형식이며, 순수 JSON 응답일 때 `parsed_json`에 분석 JSON을 보존합니다. 일반 텍스트 응답이어도 이 파일은 생성됩니다. 추론 블록과 Tool 결과를 최종 응답에 섞지 않습니다.

정상 종료된 최종 응답, 모든 Tool 요청의 종료 상태, 파일 저장 안정화를 확인해야 `completed`로 표시합니다. 다른 플러그인의 pending Tool도 완료 처리를 막습니다. 사용자 중단·실패는 `interrupted`, 종료 근거가 부족한 채 기본 120초 동안 변화가 없으면 `unknown`으로 보존합니다. 나중에 conversation이 갱신되면 다시 확인합니다.

## 모델 로그와 복구

백그라운드에서 다음 로그 스트림을 수집합니다.

```text
lms log stream --source model --filter input,output --stats --json
```

원본 이벤트와 프로세스 상태는 `outputs/results/.collector/`에 있습니다. 모델 통계는 재계산하지 않습니다. LM Studio 원본 로그에 conversation ID가 없으므로 [보수적인 연결 규칙](collector.md#모델-로그와-통계)으로 해당 Run에 유일하게 연결되는 이벤트만 `model.log`에 넣습니다. 같은 프롬프트 등으로 모호한 이벤트는 공통 원본 저장소에 보존하고 `model_capture`에 누락을 표시합니다. 과거의 미수집 스트림을 생성해 내지 않습니다.

재실행 시 기존 conversation, manifest, 원본 이벤트를 대조해 중단된 수집을 복구합니다. conversation 식별자와 이벤트 ID로 중복 폴더·중복 append를 막습니다. 기존 수동/상시 모드의 과거 결과 파일은 삭제하지 않습니다.

플러그인은 `%USERPROFILE%\.lmstudio\dfir-sherpa\desktop-collector.json`에서 수집 모드와 heartbeat만 확인합니다. 여러 대화가 하나의 전역 Run ID를 공유하지 않습니다. 원본 DB와 conversation에는 파일 쓰기를 하지 않습니다. 결과 폴더는 Git에서 제외됩니다.

## 문제 확인과 개발용 명령

준비 실패는 `outputs/launcher-error.json`, 프로세스 상태는 `outputs/results/.collector/desktop-runtime.json`, 진단 로그는 같은 폴더의 `desktop-*.stderr.log`에서 확인합니다. 비표준 설치 경로는 Git에서 제외된 `outputs/launcher-settings.json`의 `app_command`와 `logger_command` 배열로 지정할 수 있습니다.

```json
{
  "app_command": ["C:\\apps\\LM Studio\\LM Studio.exe"],
  "logger_command": ["C:\\tools\\lms.exe"]
}
```

기존 [experiment:start / experiment:stop](experiments.md), [init / collect](run-results.md)는 개발·수동 복구용입니다. 자동 모드와 동시에 실행하지 않습니다. 유지보수를 위해 자동 Collector를 종료해야 하는 개발자만 `npm run collector:stop`을 사용합니다. 일반 실험 절차에는 필요하지 않습니다.
