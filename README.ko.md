# omo-tips-translate

[English](README.md) | 한국어

OMO(senpi)의 TUI 팁을 고른 언어로 보여 주는 확장입니다. 시작할 때와 에이전트가 일하는 동안 나오는 "Tip:" 줄, 그리고 `↳ Want the full story…` 안내 줄을 사용자의 모델이 번역한 문장으로 바꿉니다. 단축키나 앱 이름처럼 OMO가 그리는 순간 계산하는 값은 그대로 맞게 들어갑니다. OMO 런타임 파일은 하나도 고치지 않습니다. 화면에 그릴 때만 문장을 바꿔치기하므로 확장을 지우면 원래 영어로 돌아갑니다.

## 화면에 보이는 것

```
팁: 언제든 Esc를 눌러 실행 중인 작업을 멈출 수 있습니다.
↳ 각 팁의 자세한 설명이 궁금하세요? 물어보세요 — give-me-tips 스킬에 안내가 있습니다.
```

처음 실행하면 전체 팁을 백그라운드에서 번역하느라 잠깐 걸립니다. 번역된 팁은 배치마다 바로 나타나는 것이 아니라 전체 번역이 끝난 뒤에 한꺼번에 적용되며, 그때까지는 영어로 보입니다. 세션은 전체 번역을 기다리느라 멈추지 않습니다. 진행 상황은 `🌐 팁 12/180`처럼 상태줄에 나옵니다.

## 설치

```sh
omo install git:github.com/yjacket/omo-tips-translate
```

omo가 저장소를 `~/.omo/agent/git/github.com/yjacket/omo-tips-translate`에 클론하고 `~/.omo/agent/settings.json`의 `packages`에 등록합니다. 실행 중인 세션에서 `/reload`를 입력하세요.

편의 스크립트도 있습니다. 같은 명령을 실행합니다.

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/yjacket/omo-tips-translate/main/install.ps1 | iex
```

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/yjacket/omo-tips-translate/main/install.sh | sh
```

**업데이트:** `omo update --extensions`로 git 설치된 확장 전체를 갱신합니다. 이것만 갱신하려면 `omo update --extension git:github.com/yjacket/omo-tips-translate`. 그 뒤 실행 중인 세션에서 `/reload`를 입력하세요.

**제거:** `omo remove git:github.com/yjacket/omo-tips-translate`를 실행하고 `/reload` 하거나 omo를 다시 시작합니다. 팁이 다시 영어로 보입니다. 저장된 번역까지 지우려면 `~/.omo/agent/omo-tips-translate.json`을 삭제하세요.

## 첫 실행

저장된 번역이 없으면 TUI에서 두 가지를 묻습니다.

1. **모델** - 번역에 쓸 모델입니다. 지금 쓰는 모델이 목록 맨 앞에 나옵니다. 세션에서 쓸 수 있는 모델이면 무엇이든 고를 수 있습니다.
2. **언어** - 한국어, 日本語, 简体中文, 繁體中文, Español, Français, Deutsch, Português, Русский 가운데 하나, 또는 직접 입력한 언어입니다.

답은 저장되고 번역은 백그라운드에서 돌아갑니다. 실패한 항목은 알려 주지만 세션을 막지 않으며, 번역하지 못한 팁은 영어로 남습니다.

OMO 업데이트로 팁 원문이 바뀌면 새 팁을 번역할지 한 번 묻습니다. 팁이 빠지기만 했으면 번역할 것이 없으니 묻지 않습니다. 예를 고르면 바뀐 팁과 새 팁만 번역하고 나머지 번역은 그대로 둡니다. 아니오를 고르면 그 원문 해시를 기억해 같은 질문을 다시 하지 않습니다. 어느 쪽이든 바뀌지 않은 팁은 기존 번역으로 계속 보입니다.

print, JSON, RPC 모드에서는 질문하지 않고 저장된 표를 그대로 씁니다.

## `/tips-translate`

인자 없이 실행하면 메뉴가 열립니다.

- **언어 바꾸기** - 다른 언어를 고르고 다시 번역합니다.
- **모델 바꾸기** - 앞으로 번역할 모델을 바꿉니다.
- **다시 번역** - 현재 원문으로 표를 새로 만듭니다.
- **끄기 / 켜기** - 팁 문장 바꾸기를 멈추거나 다시 시작합니다. 끄더라도 저장된 표는 남습니다.
- **상태** - 언어, 모델, OMO 버전, 번역된 항목 수, 실패 수를 보여 줍니다.

`/tips-translate <언어>`는 메뉴 없이 바로 그 언어로 번역합니다. 예: `/tips-translate 한국어`, `/tips-translate Español`.

## 저장되는 번역

번역은 모든 세션이 함께 쓰는 파일 하나에 저장됩니다.

```
~/.omo/agent/omo-tips-translate.json
```

에이전트 디렉터리는 OMO의 일반 우선순위(`OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR`)를 따릅니다. 파일에는 OMO 버전, 원문 팁 해시, 모델, 언어, 확장 켜짐 여부, 팁별 `en`/`tr` 쌍이 들어갑니다. 쓰기는 원자적으로 하고, 10분짜리 잠금으로 여러 세션이 동시에 열려도 같은 원문을 두 번 번역하지 않습니다.

파일은 사용자 것이며 지워도 됩니다. 지우면 다음 세션에서 모델과 언어를 다시 묻습니다.

## 동작 방식과 안전장치

이 확장은 모든 팁 줄이 지나가는 `@earendil-works/pi-tui`의 `Text.prototype.render`를 감싸고, `Tip: `로 시작하는 줄과 정확히 일치하는 영어 안내 줄만 처리합니다. 원문 목록은 실행 중인 OMO 설치의 `dist/bundle/chunks/*.js`에서 먼저 읽고, 없으면 `dist/modes/interactive/tips/catalog/*-tips.js`를 씁니다. 영어 문장은 직접 만든 스캐너로 읽으며 `eval`이나 `Function`은 쓰지 않습니다.

- **런타임 파일을 고치지 않습니다.** OMO 파일이나 `settings.json`에 쓰지 않습니다. 바뀌는 것은 메모리에서 그리는 문장뿐입니다.
- **영어 폴백.** 번역이 없거나, 플레이스홀더가 맞지 않거나, 저장 파일이 깨졌거나, 내부 접점이 없으면 원래 영어 문장을 그대로 씁니다.
- **세션당 경고 한 번.** OMO 업데이트로 렌더 접점이 사라지면 화면은 그대로 두고 그 사실을 한 번만 알립니다.
- **플레이스홀더 보존.** 원문과 같은 `{0}`, `{1}`, … 슬롯을 가진 번역만 받습니다. 명령, 플래그, 파일 이름, 키 이름, 백틱 코드는 번역하지 않습니다.
- **리로드 안전.** `Symbol.for` 마커로 프로토타입 훅을 프로세스당 한 번만 설치하고, `/reload` 때는 훅을 쌓지 않고 디스패치 대상만 바꿉니다.
- **외부 서비스 없음.** 번역은 실행 중인 OMO 세션에서 고른 모델로 합니다. 외부 번역 API를 쓰지 않습니다.

## 한계

- pi-tui 내부 구현에 기대고 있어서 OMO 업데이트로 접점이 사라질 수 있습니다. 그때는 팁이 영어로 남고 경고가 한 번 뜹니다.
- 팁 줄과 그 안내 줄만 번역합니다. 다른 화면 문구는 건드리지 않습니다.
- 모델 인증이 없거나 번역 응답을 검증할 수 없으면 해당 팁은 영어로 남습니다.

## 개발

변경은 PR로 반영합니다. 워크트리를 만들어 작업하고 PR을 열어 주세요. `test` 체크를 통과해야 머지할 수 있습니다.

로컬에서 테스트 실행:

```sh
bun test
```

테스트는 순수 모듈과 확장 연결부를 함께 대상으로 하는 `bun:test` 단위 테스트입니다. 원문 추출과 해시, 플레이스홀더와 ANSI 코드가 섞인 줄 매칭, 원자적 저장과 세션 간 잠금, 배치 번역 검증, 그리고 첫 실행·원문 변경·명령·리로드·접점 없음·저장 파일 손상 경로를 다룹니다. 확장 테스트는 가짜 senpi/pi-tui 모듈과 새 임포트만 쓰고 실제 OMO 세션은 쓰지 않으며 sleep도 쓰지 않습니다.

격리된 라이브 리플레이(`bun qa/live-replay.mjs`)는 임시 에이전트 디렉터리로 실제 TUI를 구동합니다. 자세한 방법은 [CLAUDE.md](CLAUDE.md)에 있습니다. 라이브 테스트는 `~/.omo`, 실제 health 데몬, inbox 서버, HKCU Run 값을 건드리지 않습니다. 임시 HOME/USERPROFILE/APPDATA/LOCALAPPDATA를 씁니다.

Bun >= 1.4가 필요합니다.

## 라이선스

MIT. [LICENSE](LICENSE) 참고.
