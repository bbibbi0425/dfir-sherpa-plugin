# 새 채팅을 이용한 순차 실험

`DFIR-Sherpa-Batch.cmd`는 선택한 SQLite 목록을 순서대로 실행하는 별도 launcher입니다. 네 retrieval Tool, sampling, 반환 제한, 기존 Collector와 결과 파일 형식은 그대로 사용합니다.

## 실행

1. LM Studio에서 실험 모델 **하나만** 로드하고 `local/dfir-sherpa`만 활성화합니다. Integrations에서 DB 설정과 네 Tool 목록이 보이도록 펼쳐둡니다. 무인 실행을 원하면 사용자가 네 읽기 전용 Tool의 승인 정책을 허용으로 설정해야 합니다. 실행기가 승인 정책을 바꾸거나 승인창을 대신 누르지는 않습니다.
2. **DFIR-Sherpa-Batch.cmd**를 더블클릭합니다. **Choose folder**로 DB 폴더를 선택하고 실행할 파일만 체크합니다. **Up/Down**으로 실행 순서를 정합니다. 다른 폴더의 파일은 **Add SQLite files**로 추가할 수 있습니다.
3. 모든 채팅에 사용할 공통 Prompt를 입력하고 **Start batch**를 누릅니다. 체크한 DB를 위에서 아래 순서로 실행하며, **DB 하나당 새 채팅 하나**에서 DB 설정 → 동일 Prompt 전송 → 완료·저장 확인을 반복합니다.

창에는 DB의 절대 경로가 표시됩니다. 폴더를 선택하면 바로 아래의 `.sqlite`, `.sqlite3`, `.db` 파일만 불러옵니다. 하위 폴더와 링크 파일은 제외하고, 파일명의 숫자를 고려해 정렬합니다(예: case2 → case10). 이때 모든 파일은 체크 해제 상태이며 **Check all / Uncheck all**로 일괄 선택·해제가 가능합니다. 폴더를 다시 선택하면 기존 목록을 교체합니다. 개별 파일 추가는 목록 끝에 체크된 상태로 붙으며, 동일한 DB를 여러 번 추가하면 각각 별도 채팅에서 반복합니다.

실행하는 것은 체크한 파일뿐이며, 최종 실행 순서는 화면의 위에서 아래 순서 그대로입니다. 목록을 옮겨도 체크 상태를 유지합니다. 시작 후에는 저장된 실행 목록을 사용하므로 폴더에 파일을 추가해도 실행 대상이 바뀌지 않습니다. 파일명에서 사건을 추측하거나 모델에 폴더 탐색 권한을 주지 않습니다. 선택한 DB는 실행 전 기존 스키마 검증을 read-only로 거칩니다.

`outputs/batch-prompt.txt`가 있으면 공통 Prompt 입력창의 초기값으로 불러옵니다. 체크한 DB의 순서와 Prompt는 Git에서 제외되는 `outputs/batches/plans/`에 저장됩니다.

## 실행 조건과 중단

- Windows LM Studio의 실제 새 채팅을 사용합니다. REST API 대화를 GUI 채팅으로 가정하거나 원본 conversation JSON을 직접 생성·수정하지 않습니다.
- Windows 기본 .NET Framework의 C# 컴파일러와 Windows UI Automation COM API를 사용합니다. 첫 실행 시 OS의 UIAutomationCore 형식 정보를 읽어 연결용 DLL과 보조 실행 파일을 `outputs/.batch-runtime/`에 빌드합니다. 레지스트리에 등록하지 않으며 추가 npm 패키지는 필요하지 않습니다.
- LM Studio 0.4.25 영어 UI에서 관측한 컨트롤 이름을 사용합니다. 다른 언어·UI 버전 또는 접힌 설정창에서는 입력을 시도하지 않고 오류로 중단할 수 있습니다.
- 새 채팅이 비어 있고 DFIR Sherpa만 활성화되어 있는지 확인합니다. `Canonical timeline DB`에 선택한 경로를 입력하고, `SHERPA_RUN_ID`에 채팅 연결용 고유 토큰을 넣습니다. 실제 결과 Run ID는 기존 Collector가 결정합니다.
- Prompt 전송은 한 번만 시도합니다. 전송 결과가 불명확하면 재전송하지 않습니다. 같은 모델 정보, 같은 Prompt, 해당 DB·채팅인지 계속 확인합니다.
- 설정과 Prompt 입력은 해당 입력칸에 포커스를 준 뒤 수행하고, 비동기 화면 갱신을 기다려 값을 확인합니다. 저장된 채팅의 DB 설정과 `clientInput`이 선택한 DB·공통 Prompt와 일치해야 Send를 호출합니다. 화면 접근성이 덧붙이는 문단 끝 줄바꿈만 화면 비교에서 허용하며, 저장된 Prompt의 공백이나 내용을 임의로 자르지 않습니다.
- Collector가 `completed`, DB 불변, Tool 종료 및 model output/statistics 로그 수집을 확인하고 필요한 결과 파일을 저장한 후에만 다음 DB로 넘어갑니다. 출력 이벤트가 누락되면 대기하다 제한시간에 중단합니다.
- 모델·Tool 오류, DB 변경, 추가 사용자 Prompt, 다른 모델, Collector 중단, 2시간 제한시간 초과는 이후 DB 실행을 중단시킵니다. 이미 생긴 채팅과 결과는 보존합니다.
- 자동화가 UI를 조작하는 순간에는 LM Studio 채팅이나 설정을 직접 바꾸지 마세요. Windows 데스크톱은 잠금 해제 상태여야 합니다. **Chats 사이드바의 New 버튼**과 Integrations 설정을 펼쳐두세요. 최소화된 창은 복원하고, 새 채팅은 해당 창의 New 버튼을 직접 호출합니다. 다른 앱에 전역 키 입력을 보내거나 포커스 강제 전환을 요구하지 않습니다.

**DFIR-Sherpa-Batch-Stop.cmd**로 다음 작업 진행을 취소할 수 있습니다. 현재 모델 응답을 강제 종료하거나 기존 Collector를 종료하지는 않습니다. 필요하면 LM Studio에서 현재 생성을 직접 멈추세요.

화면 점검은 별도 MTA 스레드에서 수행하며, Chromium 문서 영역을 찾아 컨트롤 정보를 한 번에 캐시합니다. 보조 프로그램이 시간 초과하거나 비정상 종료하면 `outputs/batch-error.json`에 실패한 UI 작업과 마지막 점검 단계를 기록합니다. 빈 출력을 JSON 오류로 바꾸거나 불확실한 Prompt 전송을 자동 재시도하지 않습니다.

## 저장 위치

```text
outputs/batches/
  plans/<id>.json                 # 선택 목록 + 공통 Prompt
  latest.json                    # 최근 배치 상태
  batch_<id>/
    batch.json                   # 각 DB의 상태·hash·conversation 경로·실제 Run 연결
    prompt.txt
outputs/results/<run_id>/        # 기존 Collector의 결과 파일들
outputs/batch-error.json         # 실행 실패 이유
```

배치가 비정상 종료된 상태에서 다시 실행해도 이전 Prompt를 자동 재전송하지 않습니다. 이전 배치는 중단 상태로 남고 기존 Collector가 채팅 결과를 복구합니다. `batch.json`의 해당 conversation을 확인한 후, 재실행할 DB만 새 목록으로 선택하세요.

기존 Collector는 원본 model stream에 conversation ID가 없으므로 **동일 Prompt를 반복하면 model input 이벤트 연결이 모호해질 수 있습니다.** 이 경우 `run.json.model_capture`의 `partial_or_unavailable` 표시와 공통 `.collector/model-events/` 원본 저장소를 그대로 유지합니다. 배치는 output/statistics 이벤트가 모두 연결된 경우 진행하며, 완료 당시의 수집 상태도 `batch.json`에 저장합니다. 모든 model input이 Run별로 완전히 분리됐다고 표시하지 않습니다. 이 제약을 해결하기 위한 Collector 변경은 이번 기능에 포함하지 않습니다.

개발용 명령:

```text
npm run batch
npm run batch:stop
npm run test:batch
node scripts/batch.mjs --plan <absolute-plan.json>
```

plan은 `{"databases":["<absolute SQLite path>","<another SQLite path>"],"prompt":"<common prompt>"}` 형식입니다. 실제 경로와 연구용 Prompt는 공개 코드에 넣지 않습니다.
