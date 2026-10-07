<div align="center">
  <img src="https://raw.githubusercontent.com/BiQnT/alt2obsidian/main/docs/assets/banner.png" alt="Alt2Obs: 도트 Alt 키가 크리스털로 바뀌는 그림" width="384">
  <h1>Alt2Obs</h1>
  <p><strong>Alt 강의 녹음과 슬라이드를 서로 이어진 Obsidian 노트로 바꿉니다.</strong></p>
  <p>
    <a href="https://github.com/BiQnT/alt2obsidian/blob/main/README.md">English</a> ·
    <a href="https://github.com/BiQnT/alt2obsidian/blob/main/docs/user-guide.ko.md">사용자 가이드</a> ·
    <a href="https://github.com/BiQnT/alt2obsidian/releases">릴리스</a> ·
    <a href="https://github.com/BiQnT/alt2obsidian/issues">버그 신고</a>
  </p>
</div>

Alt2Obs는 [Alt](https://www.altalt.io) 앱으로 강의를 녹음하는 학생을 위한 플러그인입니다. 이 컴퓨터의 Alt 데스크톱 앱에서 강의를 읽어 강의마다 노트 하나를 vault에 만듭니다. 노트에는 슬라이드마다 섹션이 있고, 내 Claude Code나 Codex CLI가 그 슬라이드와 그 슬라이드를 설명한 녹음 구간을 보고 해설을 씁니다. 핵심 개념은 `[[위키링크]]`로 이어진 개념 노트가 됩니다. PDF와 노트가 함께 스크롤되는 뷰어에서 공부하고, 내가 쓴 메모는 다시 가져와도 그대로 남습니다.

화면과 만들어지는 노트는 한국어이고, 학술 용어는 영어로 둡니다. 2.0.0 전 이름은 **Alt2Obsidian**이었습니다. 플러그인 id는 `alt2obsidian`입니다(`alt-to-obs`를 쓴 것은 2.0.0뿐입니다).

<p align="center">
  <img src="https://raw.githubusercontent.com/BiQnT/alt2obsidian/main/docs/assets/screenshot-viewer.png" alt="Synced Viewer: 왼쪽에 강의 PDF, 오른쪽에 Alt2Obs 노트가 같은 슬라이드에 맞춰진 화면" width="800">
  <br>
  <em>Synced Viewer: 슬라이드 PDF와 강의 노트를 나란히 놓고 전사 패널을 연 모습.</em>
</p>

## 주요 기능

- **Alt에서 바로 가져오기.** 사이드바에 이 컴퓨터 Alt 데스크톱 앱의 강의가 Alt 폴더별로 보이고, 검색과 강의별 상태(새 노트, 가져옴, 슬라이드 변경)도 볼 수 있습니다. 공유 링크가 필요 없고, Alt의 요약과 메모도 함께 가져옵니다. 공개 공유 링크로 가져오는 방법은 대체 경로로 남아 있습니다.
- **슬라이드마다 해설.** 내 Claude Code나 Codex CLI가 슬라이드 텍스트(도표 슬라이드는 이미지까지)와 그 슬라이드의 전사를 보고 슬라이드마다 섹션을 씁니다. 표지, 목차, 마무리 슬라이드와 애니메이션 때문에 겹치는 장면에는 모델을 부르지 않고, 핵심 다이어그램은 이미지로 저장해 노트에 넣을 수 있습니다.
- **전사를 슬라이드에 맞춤.** Alt 앱에서 가져온 강의는 시각이 있는 전사를 스크립트가 슬라이드별로 나눕니다(토큰 0). 그래서 슬라이드마다 그 슬라이드를 띄워 둔 동안 한 말이 붙습니다.
- **Synced Viewer.** 슬라이드 PDF와 노트를 나란히 놓고 함께 스크롤합니다. 전사 패널은 지금 슬라이드 구간의 전사를 `[mm:ss]` 시각과 함께 보여 줍니다. 강의 PDF를 열면 이 뷰어로 열립니다.
- **슬라이드 없는 강의.** 녹음만 있는 강의는 약 12분마다 구간을 나눈 요약 노트가 되고, 항목마다 그 말이 나온 `[mm:ss]` 시각이 붙습니다. 강의 PDF를 첨부해 슬라이드 강의로 가져올 수도 있습니다.
- **내 노트 검증.** 내가 쓴 노트(vault 파일, 붙여넣은 글, Notion MCP로 가져온 노션 페이지)를 슬라이드, 전사와 대조합니다. 주장마다 판정과 근거 링크가 붙고, 노트에서 빠진 슬라이드도 알려 줍니다.
- **메모를 지키는 다시 가져오기.** `> [!note] 내 메모` 콜아웃과 관리 블록 밖에 쓴 글은 다시 가져와도 그대로입니다. 슬라이드가 추가·삭제되거나 순서가 바뀌어도 메모는 자기 슬라이드를 따라가고, 바뀐 슬라이드만 새로 만듭니다.
- **모델과 비용은 내가 정함.** 작업마다 프로바이더, 모델, effort(추론 강도)를 고르거나 프리셋을 씁니다. 실행할 때마다 예상 호출 수, 토큰, 이미지 수를 먼저 보고, 그 실행에만 쓸 모델로 바꿀 수 있습니다. 노트를 저장하기 전이면 언제든 취소할 수 있습니다. 실제 사용량은 노트와 설정에 남습니다.
- **개념 노트.** 핵심 개념은 `Pipeline Hazard (파이프라인 해저드)`처럼 `English (한국어)` 이름의 노트가 됩니다. 해설에서 링크로 이어지고, 같은 과목의 다른 강의에서도 같은 노트에 이어 씁니다.

<p align="center">
  <img src="https://raw.githubusercontent.com/BiQnT/alt2obsidian/main/docs/assets/screenshot-import.png" alt="Alt2Obs 사이드바: 강의 종류가 보이는 Alt 노트 목록과 가져오기 전 예상 사용량" width="420">
  <br>
  <em>Alt에서 강의를 고르고, 실행 전에 예상 사용량을 확인합니다.</em>
</p>

## 요구 사항

- **데스크톱 Obsidian 1.7.2 이상.** 데스크톱 전용입니다. macOS에서 확인했고, Windows와 Linux는 단위 테스트로만 확인했습니다.
- **Alt 데스크톱 앱.** 강의 목록을 읽으려면 같은 컴퓨터에 있어야 합니다. 없으면 공개 공유 링크로 가져올 수 있습니다.
- **Obsidian 안의 Node 22.13 이상.** Node 내장 `node:sqlite`로 Alt 데이터베이스 사본을 읽을 때 씁니다. Alt가 꺼져 있을 때, 그리고 Alt가 켜져 있어도 동기화된 슬라이드 파일의 위치를 찾을 때 필요합니다. 개발자 콘솔(Ctrl+Shift+I, macOS는 Cmd+Option+I)을 열고 `process.versions.node`를 입력하면 버전을 볼 수 있습니다. Node가 더 오래되었다면 Alt를 켠 뒤 가져오세요. 이때 동기화된 슬라이드 파일은 찾지 못할 수 있습니다.
- **Claude Code나 Codex CLI**를 설치하고 로그인해 둡니다. 생성은 내 요금제로 합니다. Claude Code를 쓸 수 있는 Claude 계정(유료 Claude 요금제나 Anthropic API 크레딧)이나, Codex가 포함된 ChatGPT 요금제(또는 OpenAI API 키)가 필요합니다.
- 선택: 노션에 정리한 노트를 검증하려면 Notion 계정과 Claude Code의 Notion MCP.

## 설치

**커뮤니티 플러그인.** **설정 → 커뮤니티 플러그인**을 열고, 커뮤니티 플러그인이 꺼져 있으면 켭니다. **탐색**에서 "Alt2Obs"를 검색해 **설치**, **활성화**를 누르면 됩니다. 업데이트는 Obsidian의 일반 플러그인 업데이트로 받습니다.

**수동 설치.** [최신 릴리스](https://github.com/BiQnT/alt2obsidian/releases/latest)에서 `main.js`, `manifest.json`, `styles.css`를 받아 `<vault>/.obsidian/plugins/alt2obsidian/`에 넣습니다. Obsidian을 다시 불러온 뒤 **설정 → 커뮤니티 플러그인**에서 **Alt2Obs**를 켭니다.

**BRAT.** [BRAT](https://github.com/TfTHacker/obsidian42-brat)에 베타 플러그인으로 `BiQnT/alt2obsidian`을 추가하면 새 릴리스가 나올 때마다 업데이트됩니다.

### Alt2Obsidian 1.x나 2.0.0에서 올리기

- **1.x나 2.0.0 베타에서**: id와 폴더가 같아 그 자리에서 업데이트되고, 설정, 기록, 단축키가 그대로 남습니다. 노트와 메모도 그대로입니다. 1.x 노트를 2.0 폴더 구조로 옮기려면 명령 팔레트에서 **Migrate 1.x vault layout**을 실행하세요. Gemini API와 Ollama 지원은 없어졌으니, 필요하면 [1.1.0](https://github.com/BiQnT/alt2obsidian/releases/tag/1.1.0)을 계속 쓰세요. 예전 `alt2obsidian-*` 클래스로 쓴 CSS 스니펫은 `alt-to-obs-*`로 고쳐야 합니다.
- **2.0.0(id `alt-to-obs`)에서**: Obsidian은 2.0.0과 그 뒤 버전을 서로 다른 플러그인 둘로 다루고, 목록에는 둘 다 Alt2Obs로 나옵니다. 새 버전을 설치하고, 2.0.0은 지우지 말고 끄기만 한 뒤 새 버전을 켭니다. 새 버전이 2.0.0의 설정과 기록을 한 번 가져오고 알려 줍니다. 그다음 2.0.0을 삭제하고 단축키를 다시 지정하세요. 자세한 내용은 [사용자 가이드](https://github.com/BiQnT/alt2obsidian/blob/main/docs/user-guide.ko.md#200id-alt-to-obs에서-옮기기)에 있습니다.

## 빠른 시작

1. 터미널에서 Claude Code나 Codex를 설치하고 한 번 로그인합니다(`claude` 또는 `codex login`).
2. Alt2Obs를 켜고 **설정 → Alt2Obs**를 엽니다. **LLM 연결** 카드에 CLI의 경로와 버전이 보여야 합니다.
3. 리본의 책 아이콘(**Alt 강의 가져오기**)을 눌러 사이드바를 엽니다. **Alt 노트 목록** 탭에서 강의를 고르고 과목을 확인합니다.
4. **가져오기**를 누르고 예상 사용량을 확인한 뒤 **시작**을 누릅니다.
5. 노트가 Synced Viewer로 열립니다. 슬라이드마다 있는 `> [!note] 내 메모` 콜아웃에 내 메모를 씁니다.

모든 옵션과 슬라이드 없는 강의, 노트 검증, 문제 해결은 [사용자 가이드](https://github.com/BiQnT/alt2obsidian/blob/main/docs/user-guide.ko.md)에 있습니다.

## 개인정보와 공개 안내

Alt2Obs에는 텔레메트리, 사용 통계 수집, 광고, 업데이트 확인이 없습니다. 플러그인이 보내는 것, 필요로 하는 것, vault 밖에서 건드리는 것은 아래가 전부입니다.

### 네트워크 사용

- **Anthropic(Claude Code) 또는 OpenAI(Codex).** 해설, 요약, 개념 추출, 선택 사항인 전사 정렬 확인, 노트 검증은 내 CLI(`claude`나 `codex`)를 자식 프로세스로 실행해 만듭니다. 호출마다 CLI가 그 호출의 자료를 내 계정으로 Anthropic이나 OpenAI에 보냅니다. 플러그인이 이 서비스들에 직접 보내는 것은 없습니다. 호출에 들어갈 수 있는 것:
  - 슬라이드 텍스트, 도표 슬라이드의 이미지
  - 전사 발췌, Alt 요약과 메모
  - 강의 제목과 과목, 개념 이름, 그 과목 폴더의 노트들이 이미 쓰는 태그(내가 직접 쓴 노트의 태그 포함)
  - 노트 검증이면 내 노트의 문장과 그 근거
- **Notion(선택, 노트 검증).** 노션 페이지를 가져올 때는 Notion MCP 서버의 조회 도구 하나만 쓸 수 있는 Claude Code 호출을 한 번 합니다. Claude Code가 페이지를 받으러 Notion에, 모델 호출을 위해 Anthropic에 접속합니다. 페이지 URL과 페이지 내용도 Anthropic에 갑니다. 내용은 그 호출의 도구 결과로 전달됩니다.
- **다른 MCP 서버(Notion을 쓸 때만).** 가져오기 전에 `claude mcp list`가 Claude Code에 설정된 MCP 서버를 모두 연결 확인합니다. 이때 로컬 서버를 실행하거나 원격 서버에 접속할 수 있습니다. Notion 서버를 호출에 따로 넘길 수 없는 경우(claude.ai 커넥터, 또는 헤더 없는 `https` 주소가 아닌 서버)에는 가져오기 호출이 다른 MCP 서버도 실행합니다. 그 서버들의 도구는 막아 둡니다.
- **altalt.io와 슬라이드 링크(선택, 공유 링크로 가져오기).** altalt.io에서 Alt 공유 페이지를 내려받고, 그 페이지에 있는 슬라이드 링크에서 슬라이드 PDF를 그대로 내려받습니다. 지금 이 링크는 Alt의 Cloudflare R2 저장소(`*.r2.cloudflarestorage.com`)를 가리킵니다. 오래된 Alt 노트는 예전 저장소인 Supabase(`*.supabase.co`)를 가리킬 수 있습니다.
- **Alt 로컬 API**는 이 컴퓨터 안(127.0.0.1)에서만 씁니다.
- 플러그인이 하는 네트워크 연결은 이것이 전부입니다. Claude Code와 Codex는 자체 설정에 따라 자기 서비스에 따로 접속할 수 있습니다.

### 계정과 비용

플러그인은 무료입니다. 주요 기능에는 LLM CLI 로그인이 필요합니다. Claude Code를 쓸 수 있는 Claude 계정(유료 Claude 요금제나 Anthropic API 크레딧)이나, Codex가 포함된 ChatGPT 요금제(또는 OpenAI API 키)입니다. 모든 호출은 내 요금제 한도나 API 사용량을 씁니다. Notion MCP를 쓰려면 Notion 계정이 필요합니다(선택). 강의는 Alt 앱과 내 Alt 계정에서 오며, 플러그인은 Alt에 로그인하지 않습니다.

### vault 밖의 파일과 프로그램

- **Alt 데이터 폴더**는 읽기만 합니다. macOS `~/Library/Application Support/alt`, Windows `%APPDATA%\alt`, Linux `$XDG_CONFIG_HOME/alt` 또는 `~/.config/alt`, 아니면 설정에서 정한 폴더입니다. 공유 링크 없이 강의 목록을 보여 주고 가져오려면 필요합니다. 읽는 것:
  - 로컬 API 토큰과 서버 설정(`http-server-token`, `storage-httpServer.json`), 로그인한 계정(`storage-desktopSync.json`). 토큰은 메모리에만 둡니다.
  - Alt 데이터베이스. OS 임시 폴더에 따로 복사한 사본을 읽습니다. Alt 로컬 API를 쓸 수 없을 때(Alt가 꺼져 있거나, 로컬 서버가 꺼져 있거나, 아래 포트 확인에 실패했을 때), 그리고 Alt가 켜져 있어도 동기화된 슬라이드 파일의 위치를 찾을 때 복사합니다. 사본은 플러그인이 Alt에 다시 연결하거나 꺼질 때까지 두었다가 지웁니다. 비정상 종료로 남은 사본은 한 시간이 지난 뒤 다음 복사 때 지웁니다.
  - 슬라이드 PDF 파일. Alt가 기록해 둔 경로에서 읽습니다(보통 Alt 데이터 폴더 안).
- **Alt 포트 확인.** Alt 로컬 API에 토큰을 보내기 전에, 그 포트에서 듣는 프로그램이 내가 실행한 Alt인지 확인합니다. `lsof`, `ps`(macOS), `/proc`(Linux), `netstat`, `tasklist`(Windows)를 씁니다.
- **CLI 찾기.** 로그인 셸을 `$SHELL -ilc 'command -v claude'`(또는 `codex`. `$SHELL`이 없으면 `/bin/zsh`)로 실행하므로 `.zshrc` 같은 셸 시작 파일을 읽어 들입니다. Windows에서는 `where`를 씁니다. 흔한 설치 폴더도 살펴봅니다.
- **CLI 확인**(모델 호출 없음): `--version`, `--help`, `claude auth status`, `codex login status`, 그리고 Notion용 `claude mcp list`, `claude mcp get`.
- **CLI 실행.** 호출은 임시 폴더에서 실행하고 끝나면 그 폴더를 지웁니다. Windows에서는 npm으로 설치한 CLI를 `node.exe`로 실행하고, 취소하면 `taskkill`로 끝냅니다.
- **CLI가 할 수 있는 일.** Claude Code는 도구를 모두 끈 채 실행합니다. 예외는 노션 페이지를 가져오는 호출 하나로, Notion 조회 도구만 쓸 수 있습니다. Codex는 읽기 전용 샌드박스에서 실행하지만, 이 샌드박스도 내 계정이 읽을 수 있는 파일은 읽을 수 있습니다. 프롬프트로 주어진 내용만 쓰라고 지시하지만, 이 점을 감수할 때만 Codex를 고르세요.
- **모델 목록용으로 읽는 파일:** `~/.claude/cache/model-catalog/*-cc.json`(또는 `$CLAUDE_CONFIG_DIR` 아래), `~/.codex/models_cache.json`(또는 `$CODEX_HOME` 아래).
- **Notion MCP용으로 읽는 파일:** `~/.claude/plugins/installed_plugins.json`(없으면 `~/.claude/plugins` 폴더를 훑어봄), Claude Code 플러그인의 `.mcp.json`과 `.claude-plugin/plugin.json`. Claude Code가 큰 조회 결과를 `~/.claude/projects/` 아래 파일로 남길 수 있는데, 플러그인은 이 파일을 읽기만 하고 지우지 않습니다.
- **vault 밖에 쓰는 파일:** 뷰어가 보여 주는 전사와 가져온 노션 페이지를 OS 캐시 폴더(macOS `~/Library/Caches/alt2obsidian`, Windows `%LOCALAPPDATA%\alt2obsidian\Cache`, Linux `$XDG_CACHE_HOME/alt2obsidian` 또는 `~/.cache/alt2obsidian`)에 vault별로 저장합니다. 강의 텍스트가 vault 동기화에 실리지 않게 하려는 것입니다.
- **캐시 권한.** macOS와 Linux에서는 캐시 폴더와 파일을 나만 읽을 수 있게(권한 0700, 0600) 만듭니다. Windows는 이 권한을 적용하지 않으므로, 내 사용자 프로필 폴더의 기본 접근 권한을 따릅니다.

### vault 설정 폴더

vault 설정 폴더(기본은 `.obsidian`)에 id `alt-to-obs`로 나온 2.0.0이 남긴 파일을 읽기만 하고 바꾸지 않습니다.

- **처음 켤 때:** `plugins/alt-to-obs/data.json`, 그리고 그 파일과 이 플러그인 `data.json`의 수정 시각. 플러그인이 데이터를 처음 저장하기 전까지, 또는 2.0.0의 파일을 읽지 못하는 동안에는 켤 때마다 다시 읽습니다. 명령 **Import settings from version 2.0.0 (alt-to-obs)**를 실행해도 2.0.0의 파일을 다시 읽습니다.
- **켤 때마다, 그리고 PDF를 열 때마다:** 2.0.0이 아직 켜져 있는지 보려고 `community-plugins.json`과 `plugins/alt-to-obs/manifest.json`을 읽습니다.

## 문서

- [사용자 가이드](https://github.com/BiQnT/alt2obsidian/blob/main/docs/user-guide.ko.md) ([English](https://github.com/BiQnT/alt2obsidian/blob/main/docs/user-guide.md)): 설정, 가져오기, 만들어지는 노트, Synced Viewer, 노트 검증, 설정 목록, 문제 해결, FAQ.
- [영어 README](https://github.com/BiQnT/alt2obsidian/blob/main/README.md)
- 변경 내역: [GitHub 릴리스](https://github.com/BiQnT/alt2obsidian/releases). 1.x부터 모든 버전의 요약 내역은 [CHANGELOG.md](https://github.com/BiQnT/alt2obsidian/blob/main/CHANGELOG.md)(영어)에 있습니다.
- 기여자용: [2.0 명세](https://github.com/BiQnT/alt2obsidian/blob/main/docs/specs/2.0.0-spec.md), 그리고 Claude Code 세션에서 같은 프롬프트와 노트 형식으로 강의를 가져오는 [`/alt2obs` Claude Code 스킬](https://github.com/BiQnT/alt2obsidian/blob/main/scripts/phase2/README.md)(영어).

## 개발

```bash
npm install
npm run dev        # 개발 빌드 (인라인 소스 맵)
npm run build      # 프로덕션 main.js와 스킬용 CLI 번들
npm run lint       # Obsidian 공식 ESLint 규칙 (eslint-plugin-obsidianmd)
npm test           # 단위 테스트. 가짜 claude/codex를 써서 토큰을 쓰지 않음
npm run test:dom   # 헤드리스 Chromium에서 뷰어, 설정 화면, PDF.js 워커 확인
```

릴리스 파일은 `main.js`, `manifest.json`, `styles.css` 세 개이고, PDF.js 워커는 `main.js`에 들어 있습니다. `ALT2OBS_SMOKE=1 node test/smoke-cli.mjs`는 실제 CLI를 하나씩 한 번 실행하고(요금제 사용량을 조금 씀), 토큰 벤치마크는 [scripts/bench/README.md](https://github.com/BiQnT/alt2obsidian/blob/main/scripts/bench/README.md)에 설명이 있습니다.

## 라이선스와 크레딧

[MIT 라이선스](https://github.com/BiQnT/alt2obsidian/blob/main/LICENSE), 만든 사람 [BiQnT](https://github.com/BiQnT).

`main.js`에는 슬라이드 PDF를 읽고 그리는 [PDF.js](https://github.com/mozilla/pdf.js)(pdfjs-dist 4.10.38, Mozilla Foundation, Apache License 2.0)가 들어 있고, 그 라이선스 고지도 함께 들어 있습니다.

<!--
Images to capture
- README는 이미지를 main 브랜치의 raw.githubusercontent.com 주소로 불러오므로, 새 이미지는 main에 머지된 뒤에야 보입니다.
- docs/assets/screenshot-viewer.png: README.md와 같은 이미지. 슬라이드 강의를 연 Synced Viewer, 왼쪽 PDF와 오른쪽 노트가 같은 슬라이드, 툴바에 "정렬 기준 동기화 · 전사 매칭", "전사 패널"을 열어 [mm:ss] 줄이 몇 개 보이는 상태.
- docs/assets/screenshot-import.png: README.md와 같은 이미지. 사이드바 "Alt 노트 목록" 탭에서 강의 하나를 고른 상태(종류 칩 "슬라이드", 상태 칩, 과목 칸)와 "가져오기 전 예상 사용량" 패널(모델 선택, "시작" 버튼).
-->
