# Alt2Obsidian

Alt(altalt.io) 강의 노트를 Obsidian에 자동으로 가져오는 플러그인입니다.

컴퓨터에 설치된 Claude Code CLI나 Codex CLI(또는 Gemini API, Ollama)로 강의 슬라이드 1장당 한국어 해설을 만들고, 핵심 개념을 `[[Wikilink]]`와 `#태그`로 네트워크화하며, PDF와 노트를 좌우 동기 스크롤로 보여주는 전용 뷰어를 제공합니다.

## 2.0.0-beta.3에서 바뀐 점

- **새 폴더 구조 (영어 폴더명)**: 새로 가져오는 강의는 과목 폴더 아래 `Lectures/`에 노트와 PDF가 함께 저장됩니다. 개념 노트는 `Concepts/`, 노트 검증 결과는 `Verification/`, 핵심 다이어그램 이미지는 `Attachments/`에 들어갑니다(아래 구조 참고).
- **1.x 폴더 옮기기**: 명령 팔레트에서 **Migrate 1.x vault layout**을 실행하면 옮길 파일 목록(강의 노트와 옆의 PDF)을 먼저 보여주고, **옮기기**를 눌러야 옮깁니다. Obsidian의 이름 바꾸기로 옮겨서 노트 안의 링크가 함께 갱신됩니다. 지우거나 덮어쓰는 파일은 없습니다. 옮길 위치에 같은 이름의 파일이 있으면 건너뛰고 목록에 보여줍니다. `Concepts/`는 그대로이고, `Exam/`의 예전 시험 요약과 강의 노트가 아닌 내 노트는 건드리지 않습니다. 다시 실행해도 이미 옮긴 파일은 그대로입니다. 처음에는 vault 사본에서 먼저 해 보길 권합니다.
- **노트 검증 (노션 대조)**: 사이드바 **노트 검증** 탭에서 내가 쓴 노트를 강의 슬라이드와 전사에 대조합니다. 입력은 세 가지입니다.
  - **보관함 파일** (기본): 노션 페이지를 마크다운으로 내보내 vault에 넣은 파일.
  - **Notion MCP**: 노션 페이지 URL을 넣고 **가져오기**를 누르면, Claude CLI가 Notion 조회 도구 하나만 불러 페이지를 가져옵니다(호출 1회, 가져오는 중에는 같은 버튼으로 취소). 페이지 내용은 모델이 옮겨 적은 글이 아니라 조회 도구의 결과를 그대로 씁니다. 원문은 vault 밖 OS 캐시 폴더에 페이지의 마지막 수정 시각과 함께 저장되고(0600), 지난번과 같은 페이지면 그렇다고 알려줍니다. 페이지가 길어 도구 결과가 잘리면 경고합니다. Notion MCP가 없으면 설정 방법을 보여주고 보관함 파일로 검증하게 합니다.
  - **붙여넣기**.
  
  노트를 문장과 불릿 단위 주장으로 나누고, 주장마다 슬라이드 상위 2개와 정렬된 전사 구간 상위 2개를 스크립트로 찾습니다(토큰 0). 모델은 주장 20개씩 근거와 함께 받아 `맞음` / `틀림` / `근거 없음` / `전사 불확실` 중 하나와 짧은 이유를 답합니다. 스크립트가 판정을 내리는 일은 없습니다. 한국어 노트와 영어 슬라이드처럼 용어가 다르면, 괄호 속 영어 용어와 숫자 외에 자주 쓰는 한국어 전공 용어의 영어 표기(내장 용어표, 토큰 0)로도 찾고, 그래도 겹치는 용어가 없는 주장은 같은 절의 가까운 주장들이 찾은 슬라이드, 절 제목에 맞는 슬라이드, 절 전체에 맞는 슬라이드 순서로 근거 후보를 붙여 판정에 보냅니다(프롬프트에 '문맥으로 찾은 후보'로 표시). 어느 방법으로도 후보가 없는 주장은 판정하지 않고 결과 노트의 `용어 불일치로 근거 검색 실패` 절에 따로 적으며, 그런 주장이 30%를 넘으면 시작 전에 경고합니다. 슬라이드 용어를 거의 그대로 쓴 주장(숫자·수식·부정 없음)은 `맞음 후보`로 묶음 뒤쪽에 둡니다. 어떤 주장과도 이어지지 않은 슬라이드는 제목과 핵심 문장만 한 번 더 보내 `누락 후보`를 고릅니다. 시작 전에 `주장 N개 → 판정 M개`, 예상 호출과 토큰을 보여줍니다. 결과는 `Verification/<강의> verification.md`에 판정별 카드(인용, 판정, 이유, 근거 링크 `[[<강의 노트 경로>#📚 슬라이드 N|<강의> · 슬라이드 N]]`와 전사 시각 `[mm:ss]`. 경로에 `# ^ [ ] |`가 있으면 인코딩한 마크다운 링크)로 저장됩니다. 원본 노트는 바꾸지 않고, 다시 실행하면 결과 노트의 `## 내 메모` 아래는 그대로 둡니다. 설정의 **노트 검증** 작업에서 모델을 고릅니다(기본 Claude CLI `sonnet` + medium).
  - 수락 확인 (2026-09-28): lec13 덱으로 맞는 문장 20개와 일부러 틀린 문장 5개를 섞은 노트에서 틀린 문장 5개를 모두 `틀림`으로 잡았고, 맞는 문장 20개는 모두 `맞음`이었습니다(오탐 0). 호출 2회, 입력 약 19k(캐시 1k), 출력 약 1.3k 토큰(`sonnet`, low effort). 같은 문장을 영어 용어 없이 한국어로만 쓴 노트(`test/fixtures/verify/lec13-ko.json`, 전사 없음)도 25개 모두 판정으로 넘어갔고 22개는 정답 슬라이드가 근거 상위 2개에 들었습니다(가짜 판정기로 확인, 토큰 0). `node test/eval-verify.mjs <데이터 폴더> [--fixture lec13-ko] [--no-transcript] [--run | --fake]`로 다시 확인할 수 있습니다.
- **핵심 다이어그램 이미지**: 설정 **핵심 다이어그램 이미지 저장**(기본 켜짐)이 켜져 있으면, 도표·회로도·그래프처럼 그림 비중이 높은 슬라이드(강의당 최대 8장)를 스크립트로 골라(토큰 0) `Attachments/<강의>-<쪽>.png`로 저장하고 그 슬라이드 해설 끝에 `![[...]]`로 넣습니다. 이미지는 관리 블록 안에 있어 다시 가져와도 한 번만 들어가고, 같은 파일을 덮어씁니다. Claude/Codex CLI 경로에서 동작합니다.
- **시험 요약 제거**: Alt의 퀴즈·플래시카드 플러그인과 겹치는 시험 요약본 생성과 시험 범위 선택을 없앴습니다. 예전에 만든 `Exam/` 파일은 그대로 남고, 새로 만들지 않습니다.

## 2.0.0-beta.2에서 바뀐 점

- **Alt 노트 목록에서 바로 가져오기 (기본 경로)**: 사이드바 **Alt 노트 목록** 탭이 이 컴퓨터의 Alt 노트를 Alt 폴더별로 보여줍니다. 검색, 상태 칩(`새 노트` / `슬라이드 N장 변경` / `가져옴`), Alt 폴더에서 추정한 과목(수정 가능)을 보고 **가져오기**를 누르면 됩니다. 공유 링크가 필요 없고, Alt 요약과 메모도 함께 가져옵니다. 공개 URL 붙여넣기는 **URL 붙여넣기** 탭에 대체 경로로 남아 있습니다.
- **Alt 연결 상태**: Alt가 실행 중이면 로컬 API(`Alt 연결됨 · 로컬 API`), 꺼져 있으면 Alt 데이터베이스 사본(`Alt 꺼짐 · DB 읽기`)을 읽습니다. 둘 다 안 되면 `연결 안 됨`과 이유가 보입니다. 상태 표시를 누르면 다시 연결합니다.
- **전사를 슬라이드에 자동 정렬**: 로컬 노트의 전사에는 시각이 있어서, 스크립트가 전사 구간을 슬라이드에 배정합니다(토큰 0). 텍스트 레이어가 없는 스캔 PDF나 슬라이드 절반 이상에 글자가 없는 덱은 균등 분할을 씁니다. 각 슬라이드 해설에는 그 슬라이드 구간의 전사가 들어갑니다(1.x는 글자 수로 균등 분할). 정렬은 켜고 끄는 옵션이 아니며, 사이드바에 `전사 타임스탬프 있음 · 슬라이드에 자동 정렬`로 표시됩니다. 결과는 노트 frontmatter `alt_alignment`에 저장됩니다. 설정에서 **전사 정렬 확인** 작업에 모델을 고르면 불확실한 구간만 한 번의 작은 호출로 확인합니다(기본 끔).
- **Synced Viewer 전사 패널**: `alt_alignment`가 있는 노트는 툴바에 `정렬 기준 동기화 · 전사 매칭`이 보이고, **전사 패널** 버튼으로 현재 슬라이드 구간의 전사를 `[mm:ss]`와 함께 봅니다. 패널용 전사는 vault 밖 OS 캐시 폴더(macOS `~/Library/Caches/alt2obsidian`, Windows `%LOCALAPPDATA%\alt2obsidian\Cache`, Linux `~/.cache/alt2obsidian`)에 vault별로 저장하고(권한 0600), vault에서 사라진 노트의 전사는 지웁니다. 캐시가 없으면 Alt에서 다시 읽습니다.
- **정렬 정확도 (초안)**: 사람이 초안으로 라벨링한 강의 2개에서 슬라이드 배정 정확도는 80.4%와 62.9%(1.x 균등 분할 9.9%와 3.0%)입니다. 라벨이 아직 사용자 확인 전이라 명세 6절 2단계의 정렬 수락 기준은 보류 상태입니다.
- **기존 노트 연결**: 1.x나 URL로 가져온 노트(`alt_id`만 있음)와 제목·날짜가 같은 Alt 노트는 `기존 노트와 연결?`으로 표시됩니다. 확인을 눌러야만 그 노트 frontmatter에 `alt_local_id`를 추가하고, 이후 가져오기가 그 노트를 업데이트합니다(메모 보존). 자동으로 덮어쓰지 않으며, 제목이 같은 다른 강의 노트가 있으면 파일 이름에 강의 날짜를 붙여 따로 만듭니다.

> **개인정보 안내 (Alt 로컬 데이터)**: 플러그인은 이 컴퓨터의 Alt 데이터를 **읽기만** 합니다. Alt가 실행 중이면 Alt의 로컬 HTTP API(`127.0.0.1`)에 GET 요청만 보내고, 인증 토큰은 Alt의 토큰 파일(`http-server-token`)에서 읽어 메모리에만 둡니다(로그·노트·설정에 저장하지 않음). 토큰을 보내기 전에 그 포트를 연 프로그램이 이 사용자로 실행된 Alt인지 확인합니다(macOS `lsof`/`ps`, Linux `/proc`, Windows `netstat`/`tasklist`). 확인되지 않으면 토큰을 보내지 않고 데이터베이스 사본을 읽습니다. Alt가 꺼져 있으면 로그인한 계정의 Alt 데이터베이스와 WAL 파일을 임시 폴더에 복사해 그 사본을 읽고 닫을 때 지웁니다(다른 계정의 저장소는 읽지 않고, Alt와 같은 팀 채널 규칙으로 보이는 노트만 목록에 올립니다). Alt 앱, 설정, 데이터 파일은 바꾸지 않습니다. 슬라이드 PDF는 Alt가 저장한 파일을 읽어 vault에 복사합니다. 데이터베이스 읽기에는 Obsidian에 들어 있는 Node의 내장 SQLite(`node:sqlite`, Node 22.5 이상)를 씁니다. 오래된 Obsidian 설치본이라 없으면 Alt를 실행해 로컬 API로 가져오세요.

## 2.0.0-beta.1에서 바뀐 점

- **API 키 없이 생성**: 이미 구독 중인 Claude Code(`claude`)나 Codex(`codex`) CLI를 플러그인이 직접 실행합니다. Gemini API 키는 Gemini를 고를 때만 필요합니다.
- **작업별 모델 선택**: 슬라이드 해설과 개념 추출마다 프로바이더, 모델, effort를 따로 고릅니다. 프리셋 `절약` / `품질` / `사용자 지정`.
- **토큰 절약**: 슬라이드를 8장씩 묶어 한 번에 보내고(이미지가 있으면 4장), 표지·목차·마무리·애니메이션 중복 슬라이드는 LLM에 보내지 않으며, 이미지는 도표 위주 슬라이드에만 1024px JPEG로 붙입니다. 전사는 군말과 반복을 지우고 슬라이드당 600자로 줄입니다. 모든 호출의 앞부분(지시문과 강의 공통 맥락)이 같아서 두 번째 묶음부터 프롬프트 캐시에 걸립니다.
- **다시 가져오기**: 슬라이드 텍스트와 렌더링 이미지가 모두 그대로인 슬라이드는 기존 해설을 재사용하고, 바뀐 슬라이드만 생성합니다.
- **가져오기 전 예산 미리보기**: 예상 호출 수, 입력·출력 토큰, 보낼 이미지 수, 생략한 슬라이드 수를 사이드바에서 확인한 뒤 시작합니다. 강의당 토큰 상한을 넘으면 시작 전에 멈추고 이미지 줄이기를 제안합니다. 진행 중에는 단계, 묶음 진행률, 실시간 사용량, 취소 버튼이 보입니다.
- **사용량 기록**: 실제 사용량(입력, 캐시 적중, 출력)을 노트 frontmatter `alt2obs_usage`와 설정 화면의 누적 사용량에 남깁니다.

> **외부 프로그램 실행과 구독 사용량 안내**: Claude CLI나 Codex CLI를 고르면 이 플러그인은 컴퓨터에 설치된 `claude` / `codex` 프로그램을 자식 프로세스로 실행합니다. 모든 호출은 **사용자 계정의 구독 한도(또는 API 사용량)를 소모**합니다. CLI는 vault 밖 임시 폴더에서 실행되고(Claude: 도구를 모두 끄고 이미지는 메시지에 직접 담아 보냄, 설정·MCP·세션 저장 없음 / Codex: 읽기 전용 샌드박스, 세션 저장 없음), 노트 쓰기는 플러그인만 합니다. 예외는 노트 검증의 Notion MCP 가져오기 하나로, 이 호출만 Notion MCP 서버를 켜고 Notion 조회 도구 하나만 허용합니다(아래 Notion MCP 설정 참고). Codex의 읽기 전용 샌드박스는 사용자 계정이 읽을 수 있는 파일은 읽을 수 있습니다. 프롬프트로 주어진 내용만 쓰라고 지시하지만 이 위험은 남아 있으니, 감수할 수 있을 때만 Codex를 고르세요. 데스크톱 전용입니다(macOS, Windows, Linux).

## 주요 기능

- **페이지-anchored 노트 구조**: 강의 1개당 1 .md 파일에 PDF 슬라이드와 1:1로 대응하는 `## 📚 슬라이드 N` 섹션 자동 생성. 각 섹션의 해설은 슬라이드 텍스트(도표 슬라이드는 이미지 포함)와 해당 구간 음성 전사 발췌로 만듭니다.
- **사용자 메모 안전 보존**: 슬라이드별 `> [!note] 내 메모` 콜아웃은 관리 블록 바깥에 위치하며, 다음 import 때도 그대로 유지됩니다 (해시-augmented 마커가 슬라이드 reorder/insert/delete를 감지해 재정렬).
- **Synced Viewer**: 명령 팔레트에서 'Open Synced Viewer (PDF + lecture .md)'를 실행하면 PDF(좌)와 강의 노트(우)가 좌우로 떠오릅니다. **양방향 동기 스크롤** (PDF↔md), 페이지 nav 버튼, 줌, 슬라이드 번호 라벨, **wikilink 클릭 이동** (Cmd-클릭 = 새 탭), **"📝 노트 편집"** 버튼으로 split-pane editor 열기 + 편집 시 우측 자동 refresh.
- **개념 네트워크**: LLM이 한국어 강의에 한국어 개념(영어 병기), 영어 강의엔 영어 개념을 추출하고, 모든 슬라이드 섹션에 걸쳐 `[[Wikilink]]`로 일관성 있게 연결합니다. 정의 3-5문장 + 강의 맥락 2-3문장 + 구체 예시 + 시험 함정.
- **안전한 재가져오기**: 변경 요약 (reorder/insert/delete/drift 카운트)을 확인한 뒤 관리 구간만 업데이트, 사용자 메모는 보존. 슬라이드의 절반 이상이 사라지면 deck-replacement 확인 모달이 뜹니다 (실수로 다른 강의 URL을 import한 경우 방지).
- **노트 검증**: 내 노트(노션 내보내기, Notion MCP, 붙여넣기)를 슬라이드와 전사에 대조해 틀린 문장과 빠진 슬라이드를 찾습니다.
- **사이드바 UI**: Alt 노트 목록(폴더·검색·상태 칩), URL 붙여넣기, 노트 검증 탭과 과목 선택, 예상 사용량, 최근 노트를 한 곳에서 관리.
- **다중 LLM 지원**:
  - **Claude Code CLI**: `claude -p`를 실행. 기본은 슬라이드 해설 `sonnet` + medium, 개념 추출 `haiku` + low. 모델은 `sonnet`, `opus`, `haiku` 같은 별칭이나 전체 이름을 자유롭게 입력. 호출 하나가 모델 한 턴이고, CLI가 더하는 고정 입력은 약 0.45k 토큰입니다.
  - **Codex CLI**: `codex exec`를 실행. 호출마다 Codex 자체 지시문과 전역 `~/.codex/AGENTS.md`가 함께 실려 고정 비용이 큽니다(설정으로 줄일 수 있는 부분을 끈 뒤에도 이 컴퓨터 측정 약 12k 토큰, 끄기 전 18k). 플러그인은 사용자 파일을 건드리지 않고, 대신 Codex는 배치 크기의 두 배로 묶어 보냅니다.
  - **Google AI Studio**: Gemini 2.5 Flash, **Gemma 3 27B/12B/4B** (모두 멀티모달, Gemma는 무료 등급 RPM ~30으로 더 여유). 모델명만 변경.
  - **Multi-key rotation**: API 키 필드에 콤마로 여러 무료 키 입력 → 429 시 자동 round-robin (3개 키 ≈ 15 RPM).
  - **Ollama (로컬)**: 멀티모달은 `llama3.2-vision:11b`, 텍스트는 `gemma3:4b` 권장. 무제한·무료·offline.
  - 자세한 RPM 우회 옵션: [`docs/gemini-rpm-options.md`](docs/gemini-rpm-options.md) 참고.
- **Phase 2 Skill (Claude Code Max 사용자)**: `/alt2obs <alt-url>` 명령으로 Claude Code의 native vision으로 import. Gemini 쿼터 무관, 자세히는 [`scripts/phase2/`](scripts/phase2/) 참고.

> 1.0.x → 1.1.0 마이그레이션: 기존에 import한 노트는 그대로 유지됩니다. 새로 import하는 강의부터 페이지-anchored 구조로 생성됩니다.

## 설치 방법

### 준비: LLM CLI (권장)

Claude Code 또는 Codex 중 하나를 설치하고 터미널에서 한 번 로그인해 두세요.

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code   # 또는 공식 설치 스크립트
claude    # 처음 한 번 실행해 로그인

# Codex
npm install -g @openai/codex
codex login
```

Dock에서 실행한 Obsidian은 터미널의 PATH(nvm 경로 등)를 모릅니다. 플러그인은 처음 한 번 로그인 셸의 `command -v claude`와 흔한 설치 폴더(nvm, Homebrew, `~/.local/bin` 등)에서 실행 파일을 모두 찾아 각각 `--version`을 확인하고, 필요한 최소 버전(Claude Code 2.1.283, Codex 0.155.1, 이 플러그인이 쓰는 옵션을 모두 확인한 버전) 이상 중 가장 새 것을 저장합니다. 오래된 설치본만 있으면 찾은 경로와 버전을 알려주고, 저장해 둔 경로가 최소 버전보다 낮으면 다시 찾습니다. 그래도 못 찾으면 **설정 → Alt2Obsidian → LLM 연결**에 `command -v claude` 결과(절대 경로)를 넣고 '다시 찾기'를 누르세요.

**Windows**: 경로는 `where claude`로 찾고, 못 찾으면 `%APPDATA%\npm`, `%USERPROFILE%\.local\bin` 등을 살펴봅니다. npm으로 설치한 `claude.cmd` / `codex.cmd`는 셸 없이 실행하기 위해 스크립트 안의 JavaScript 파일을 찾아 `node.exe`로 직접 실행하고(`node.exe`가 PATH나 같은 폴더에 있어야 함), 네이티브 설치본(`claude.exe`)은 그대로 실행합니다. 취소하면 `taskkill /T /F`로 프로세스 트리를 종료하고, taskkill이 실패하면 직접 실행한 프로세스라도 종료합니다. `where`는 콘솔 코드 페이지로 경로를 출력하므로 사용자 이름에 한글 같은 비ASCII 문자가 있으면 결과가 깨질 수 있는데, 이때는 환경 변수로 만든 설치 폴더 탐색이 대신 찾습니다. Windows 경로는 단위 테스트로만 확인했고 실제 Windows PC에서는 아직 확인하지 않았습니다.

### 방법 1: 수동 설치 (지금 바로 사용)

1. [최신 Release](https://github.com/BiQnT/alt2obsidian/releases)에서 아래 파일을 다운로드합니다:
   - `main.js`
   - `manifest.json`
   - `styles.css`
   - `pdf.worker.min.mjs`

2. Obsidian Vault 폴더에서 `.obsidian/plugins/alt2obsidian/` 폴더를 생성합니다:
   ```
   내 Vault/
   └── .obsidian/
       └── plugins/
           └── alt2obsidian/
               ├── main.js
               ├── manifest.json
               ├── styles.css
               └── pdf.worker.min.mjs
   ```

3. 다운로드한 4개 파일을 해당 폴더에 복사합니다.

4. Obsidian을 재시작하거나 `Cmd+R` (Mac) / `Ctrl+R` (Windows)로 리로드합니다.

5. **설정 → 커뮤니티 플러그인**에서 제한 모드를 비활성화합니다.

6. 설치된 플러그인 목록에서 **Alt2Obsidian**을 활성화합니다.

### 방법 2: 커뮤니티 플러그인

> **현재 Obsidian 커뮤니티 플러그인 등록 리뷰 진행 중입니다.** 승인 전까지는 방법 1(수동 설치)을 사용해주세요.

1. **설정 → 커뮤니티 플러그인 → 탐색**에서 "Alt2Obsidian"을 검색합니다.
2. **설치** → **활성화**를 클릭합니다.

## Alt 앱에서 노트 링크 가져오는 법 (URL 대체 경로)

이 컴퓨터에 Alt 앱이 설치되어 있으면 링크 없이 **Alt 노트 목록** 탭에서 가져오면 됩니다. 아래는 다른 컴퓨터의 노트나 공유받은 노트처럼 로컬에 없는 노트를 공개 URL로 가져올 때의 방법입니다. URL 경로는 전사 시각이 없어 균등 분할을 쓰고, 요약이 비어 있는 경우가 많습니다.

### 1. Alt 앱 설치

- [alt.io](https://www.altalt.io/ko/features)에서 **Alt** 앱을 다운로드합니다.
- 회원가입 후 강의 녹음/업로드를 통해 노트를 생성합니다.

### 2. 노트 공유 링크 복사

1. Alt 앱에서 가져오고 싶은 **강의 노트**를 엽니다.
2. 우측 상단의 **공유(Share)** 버튼을 탭합니다.
3. **"링크 복사"** 를 선택합니다.
4. 아래와 같은 형식의 URL이 복사됩니다:
   ```
   https://www.altalt.io/en/note/0a471d1c-4ec6-4101-8de2-ccc1781770d4
   ```
5. 이 URL을 Alt2Obsidian 사이드바에 붙여넣으면 됩니다.

> **팁:** Alt 앱에서 **요약 버튼을 눌러 AI 요약을 먼저 생성**한 뒤 링크를 공유하면 가장 좋은 결과를 얻을 수 있습니다. 요약 없이 메모/트랜스크립트만 있는 노트도 지원하지만, Alt에서 생성한 요약이 있으면 더 정확한 개념 추출이 가능합니다.
>
> **강의자료 반영:** 공유 노트에 PDF 강의자료가 있으면 텍스트를 추출해 핵심 페이지 발췌만 LLM 프롬프트에 넣습니다. 스캔본처럼 텍스트 레이어가 없는 PDF는 원본 파일 저장만 수행합니다.
>
> **참고:** Alt 노트가 "비공개"로 설정된 경우 가져올 수 없습니다. 공유 설정이 "링크가 있는 사용자" 또는 "공개"로 되어 있어야 합니다.

## 사용 방법

### 1단계: LLM 연결

1. **설정 → Alt2Obsidian → LLM 연결**에서 Claude CLI / Codex CLI 카드에 경로와 버전이 보이는지 확인합니다.
   - 새로 설치했고 Gemini 키가 없으면, 로그인된 Claude CLI가 있을 때 자동으로 Claude CLI를 씁니다. 로그인 여부는 `claude auth status`로만 확인하고 모델은 호출하지 않습니다.
   - 1.x에서 Gemini 키(또는 Ollama)로 쓰고 있었다면 설정을 그대로 둡니다. Claude 카드의 **Claude CLI로 전환** 버튼을 누를 때만 바뀝니다.
2. **작업별 모델** 표에서 작업마다 프로바이더, 모델, effort를 고릅니다. 모델 칸을 비우면 CLI 기본 모델을 씁니다. 기본값: 슬라이드 해설은 `sonnet` + medium, 개념 추출은 `haiku` + low.
3. Gemini API를 쓰려면 [Google AI Studio](https://aistudio.google.com/apikey)에서 무료 API 키를 발급받아 Gemini 카드에 입력하고, 작업 표에서 Gemini를 고릅니다. 이때는 1.1.0과 같은 슬라이드별 호출 방식으로 동작합니다.

### 2단계: Alt 노트 가져오기

1. 왼쪽 리본의 📖 아이콘을 클릭하여 **Alt2Obsidian 사이드바**를 엽니다.

**Alt 노트 목록 (기본)**

1. 위쪽 상태 표시가 `Alt 연결됨 · 로컬 API` 또는 `Alt 꺼짐 · DB 읽기`인지 확인합니다.
2. 폴더를 펼치거나 검색해서 강의를 고릅니다. 각 노트에는 날짜, 슬라이드 수, 전사 길이와 상태 칩이 보입니다.
3. 아래 패널에서 **과목**(Alt 폴더에서 추정, 수정 가능)과 정렬 상태를 확인하고 **가져오기**를 누릅니다. 이후 과정(예상 사용량, 시작, 취소)은 아래 URL 경로와 같습니다.
4. `기존 노트와 연결?`이 보이면, 예전에 가져온 노트 경로 옆 **연결**을 눌러 확인해야 연결됩니다.

**URL 붙여넣기 (대체 경로)**

2. [Alt](https://altalt.io) 에서 공유할 노트의 URL을 복사하고 **URL 붙여넣기** 탭을 엽니다.
   - 예: `https://www.altalt.io/en/note/0a471d1c-4ec6-4101-8de2-ccc1781770d4`

3. URL을 붙여넣고 **과목명**을 입력합니다 (예: `CSED311`).
   - 기존 과목이 있으면 칩을 클릭하여 선택 가능
   - 비워두면 자동 감지 시도

4. **"가져오기"** 버튼을 클릭합니다. CLI 프로바이더라면 PDF를 분석한 뒤 **예상 사용량**(호출 수, 토큰, 이미지, 생략 슬라이드)이 먼저 나옵니다. **시작**을 누르면 생성이 시작되고, 진행 중 **취소**로 언제든 멈출 수 있습니다(취소하면 노트는 바뀌지 않습니다).

5. 잠시 후 Vault에 다음이 생성됩니다:
   ```
   Alt2Obsidian/
   └── CSED311/
       ├── Lectures/
       │   ├── CSED311 Lec7-pipelined-CPU.md    ← 강의 노트 (페이지별 섹션)
       │   └── CSED311 Lec7-pipelined-CPU.pdf   ← 원본 PDF (Synced Viewer가 노트 옆에서 찾음)
       ├── Concepts/                            ← 과목별 개념 노트
       │   ├── 파이프라인 해저드 (Pipeline Hazard).md
       │   └── ...
       ├── Verification/
       │   └── CSED311 Lec7-pipelined-CPU verification.md   ← 노트 검증 결과
       └── Attachments/
           └── CSED311 Lec7-pipelined-CPU-12.png            ← 핵심 다이어그램 (선택)
   ```
   1.x에서 만든 vault는 강의 노트가 과목 폴더 바로 아래에 있습니다. 명령 팔레트의 **Migrate 1.x vault layout**으로 옮기세요(위 2.0.0-beta.3 설명 참고).

### 3단계: 노트 검증 (선택)

1. 노션 페이지를 마크다운으로 내보내 vault에 넣거나(**보관함 파일**), 노션 URL을 넣거나(**Notion MCP**), 내용을 붙여넣습니다.
2. 사이드바 **노트 검증** 탭에서 입력과 **대상 강의**를 고르고 **예상 사용량 보기**를 누릅니다. `주장 N개 → 판정 M개`, `근거 검색 (스크립트): 토큰 0`, 예상 호출·토큰이 나옵니다.
3. **검증 실행**을 누르면 판정이 끝난 뒤 판정별 개수와 **결과 노트 열기** 버튼이 보입니다.

**Notion MCP 설정**: 터미널에서 `claude mcp add --transport http notion https://mcp.notion.com/mcp`를 실행하고 `claude`를 열어 `/mcp`에서 Notion에 로그인합니다. 플러그인은 `claude mcp list`와 `claude mcp get`(둘 다 모델 호출 없음)으로 Notion 서버를 찾고, 가져오기 호출은 다음처럼 제한합니다.
- `--tools ""`(내장 도구 없음), `--permission-mode dontAsk`, `--allowedTools mcp__<서버>__notion-fetch`: Notion 조회 도구 하나만 쓸 수 있습니다. Notion 서버의 나머지 도구(페이지 만들기·고치기 등)는 이름으로 막습니다.
- `--setting-sources ""`, `--settings '{"disableAllHooks":true}'`: 사용자 설정의 허용 규칙과 hook이 끼어들지 않습니다.
- 직접 추가한 Notion 서버(http/sse, 헤더 없음)는 `--strict-mcp-config --mcp-config`로 그 서버 하나만 켭니다. 같은 이름과 URL이라 저장된 Notion 로그인을 그대로 씁니다. 2026-09-28에 확인했을 때 모델에 보이는 도구는 notion-fetch 하나였고 호출당 입력은 약 2k 토큰이었습니다.
- claude.ai 커넥터로 연결한 Notion은 이렇게 따로 적을 수 없어, 사용자의 MCP 목록을 쓰되 다른 MCP 서버를 모두 막습니다(이 경로는 실제 호출로는 확인하지 않았습니다).

서버 이름이 다르거나 도구 이름을 직접 정하려면 설정의 **Notion MCP 조회 도구**에 `mcp__<서버>__notion-fetch` 형식으로 넣으세요. 모델은 도구를 부르기만 하므로 개념 추출 작업의 경량 모델(Claude CLI일 때)과 low effort를 씁니다.

## 생성되는 노트 구조

### 강의 노트 (페이지-anchored 1.1.0)
```markdown
---
title: "CSED311 Lec7-pipelined-CPU"
subject: "CSED311"
tags: [csed311, midterm, pipeline, cpu-architecture, hazard]
date: "2026-03-25"
source: "alt2obsidian"
slide_count: 32
alt_id: "0a471d1c-..."
---

# CSED311 Lec7-pipelined-CPU

## 📚 슬라이드 1

<!-- alt2obs:slide:1 hash:a3f5b2c1 start -->
[Gemini가 슬라이드 이미지 + 음성 전사 chunk를 보고 작성한 한국어 해설]

> [!definition] 파이프라인 (Pipeline)
> 복수의 명령어를 동시에 서로 다른 단계에서 실행해 처리량을 높이는 기법.

> "교수님이 강조: pipelining의 핵심은 latency 단축이 아니라 throughput 증가"

[[파이프라인 해저드 (Pipeline Hazard)]]는 다음 슬라이드에서 다룹니다.
<!-- alt2obs:slide:1 hash:a3f5b2c1 end -->

> [!note] 내 메모
> 시험 전 `lw → add` 사례 다시 보기

## 📚 슬라이드 2

<!-- alt2obs:slide:2 hash:b8e1d4f3 start -->
...
<!-- alt2obs:slide:2 hash:b8e1d4f3 end -->

> [!note] 내 메모
> 

(... 슬라이드 N까지 ...)
```

마커 형식: `<!-- alt2obs:slide:N hash:<8-hex> start --> ... <!-- end -->`. 해시는 정규화한 슬라이드 텍스트의 SHA-1 8자리로 페이지 번호와 무관하며(텍스트가 없는 페이지만 Alt 노트 id와 페이지 번호 기반, `src/core/slideHash.ts`), Alt이 슬라이드를 reorder/insert/delete해도 사용자 메모가 올바른 슬라이드에 따라가도록 보존합니다.

### 개념 노트
```markdown
---
tags: [concept]
---

# 파이프라인 해저드 (Pipeline Hazard)

**정의:** 파이프라인된 CPU에서 다음 명령어가 다음 사이클에 정상 실행되지 못하게 하는 상황을 말한다. 명령어 간 데이터 의존성, 분기 결정 지연, 또는 하드웨어 자원 충돌로 발생한다. 해저드를 해결하지 못하면 잘못된 결과가 나오거나 stall로 성능이 떨어진다.

**강의 맥락:** 이번 강의에서는 5단계 MIPS 파이프라인을 도입한 직후, 단순 파이프라이닝만으로는 정합성이 깨질 수 있다는 점을 보이기 위해 도입되었다. 교수님은 load-use 의존성을 가장 먼저 그림으로 보여주고, forwarding과 stall 메커니즘 도입을 정당화했다.

**예시:** `lw $t0, 0($s0)` 바로 뒤에 `add $t1, $t0, $t2`가 오는 코드. $t0의 값이 EX 단계에 도달하기 전 다음 명령어가 그 값을 필요로 하므로 1 사이클 stall 또는 forwarding이 필요하다.

**주의:** 데이터 해저드와 구조 해저드를 혼동하기 쉽다. 데이터 해저드는 의존성, 구조 해저드는 자원 충돌. 시험에서는 분기 해저드도 자주 같이 나온다.

**관련 강의:** [[CSED311 Lec7-pipelined-CPU]]
**관련 개념:** [[데이터 해저드 (Data Hazard)]], [[포워딩 (Forwarding)]], [[분기 해저드 (Control Hazard)]]
```

## 설정

| 설정 | 설명 | 기본값 |
|------|------|--------|
| LLM 연결 | Claude CLI / Codex CLI 경로(비우면 자동 탐색)와 버전, Gemini API 키, Ollama | 자동 탐색 |
| 작업별 모델 | 슬라이드 해설, 개념 추출, 전사 정렬 확인(선택, 불확실한 구간만), 노트 검증마다 프로바이더·모델·effort | 해설: Claude CLI sonnet medium / 개념: Claude CLI haiku low (Gemini 키가 있던 1.x 사용자는 전환 버튼을 누르기 전까지 Gemini) |
| 프리셋 | `절약`: 모든 작업 경량 모델 + low. `품질`: 해설·검증 상위 모델 + high | 사용자 지정 |
| 배치 크기 | CLI 호출 한 번에 보낼 슬라이드 수 (이미지가 있으면 절반) | 8 |
| 이미지 전송 규칙 | 자동(도표 위주 슬라이드와 스캔 PDF만) / 텍스트만 | 자동 |
| 슬라이드당 전사 상한 | 압축 후 남길 전사 글자 수 | 600 |
| 강의당 토큰 상한 | 예상치가 넘으면 시작 전에 멈춤. 0 = 없음 | 0 |
| CLI 호출 제한 시간 | 초과하면 중단하고 그 슬라이드만 한 번 재요청 | 300초 |
| 바뀐 슬라이드만 다시 생성 | 텍스트 해시와 이미지 신호가 같으면 기존 해설 재사용 | 켜짐 |
| 핵심 다이어그램 이미지 저장 | 그림 위주 슬라이드(최대 8장)를 `Attachments/`에 PNG로 저장하고 해설에 삽입 (CLI 경로) | 켜짐 |
| Notion MCP 조회 도구 | 노트 검증에서 노션 URL을 가져올 도구. 비우면 `claude mcp list`로 찾음 | 자동 |
| API 키 | Google AI Studio API 키. **콤마 구분으로 여러 키 입력하면 429 시 자동 rotation** | (직접 입력) |
| Gemini 모델 | `gemini-2.5-flash` (기본), `gemini-2.5-flash-lite` (RPD 여유), **`gemma-3-27b-it`** (무료 RPM ~30, 멀티모달, 추천 무료 사용 모델) | gemini-2.5-flash |
| Ollama endpoint | 로컬 Ollama 서버 URL (provider=ollama 일 때 노출) | http://localhost:11434 |
| Ollama 모델 | `gemma3:4b` (텍스트), `llama3.2-vision:11b` (멀티모달) | gemma3:4b |
| 저장 폴더 | Vault 내 저장 경로 | Alt2Obsidian |
| Alt 데이터 폴더 | Alt 노트 목록을 읽을 Alt 앱 데이터 폴더 (읽기 전용) | 비움 = 기본 위치 (macOS `~/Library/Application Support/alt`) |
| 요청 간격 | Gemini API 호출 간 대기시간(ms). 슬라이드 30+ deck면 6000+ 권장 | 4000 |
| 언어 | `ko` / `en` — concept 노트와 해설 출력 언어 | ko |

**API 키가 부족할 때 (RPM/RPD 한도):** [`docs/gemini-rpm-options.md`](docs/gemini-rpm-options.md) 에 5개 우회 옵션 (Gemma 모델 변경, multi-key, Ollama, Tier 1, Phase 2 Skill) 비교.

## 지원 환경

- macOS / Windows / Linux (데스크톱 Obsidian)
- Obsidian v0.15.0 이상

## 개발

```bash
# 의존성 설치
npm install

# 개발 빌드
npm run dev

# 프로덕션 빌드
npm run build

# 테스트 (토큰을 쓰지 않음: test/fixtures/bin의 가짜 claude/codex 사용)
npm test

# 실제 CLI로 한 번씩 확인 (구독 사용량 소량 소모)
ALT2OBS_SMOKE=1 node test/smoke-cli.mjs

# 노트 검증 수락 확인 (--run 없으면 토큰 0, 있으면 Claude CLI 호출 최대 3회)
node test/eval-verify.mjs <lec13.pdf와 전사 JSON이 있는 폴더> [--run]

# 벤치마크 (scripts/bench/README.md)
node scripts/bench/bench.mjs --pdf deck.pdf --transcript t.txt --provider claude-cli
```

## 라이선스

[MIT License](LICENSE)

## 제작자

**BiQnT** - [GitHub](https://github.com/BiQnT)
