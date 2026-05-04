# Alt2Obsidian

Alt(altalt.io) 강의 노트를 Obsidian에 자동으로 가져오는 플러그인입니다.

LLM(Gemini)을 활용하여 강의 슬라이드 1장당 한국어 해설을 만들고, 핵심 개념을 `[[Wikilink]]`와 `#태그`로 네트워크화하며, PDF와 노트를 좌우 동기 스크롤로 보여주는 전용 뷰어를 제공합니다.

## 주요 기능 (1.1.0)

- **페이지-anchored 노트 구조**: 강의 1개당 1 .md 파일에 PDF 슬라이드와 1:1로 대응하는 `## 📚 슬라이드 N` 섹션 자동 생성. 각 섹션 안의 Gemini 해설은 슬라이드 이미지 + 해당 구간 음성 전사 발췌를 입력으로 한 번씩 호출되어 만들어집니다.
- **사용자 메모 안전 보존**: 슬라이드별 `> [!note] 내 메모` 콜아웃은 관리 블록 바깥에 위치하며, 다음 import 때도 그대로 유지됩니다 (해시-augmented 마커가 슬라이드 reorder/insert/delete를 감지해 재정렬).
- **Synced Viewer**: 명령 팔레트에서 'Open Synced Viewer (PDF + lecture .md)'를 실행하면 PDF(좌)와 강의 노트(우)가 좌우로 떠오릅니다. **양방향 동기 스크롤** (PDF↔md), 페이지 nav 버튼, 줌, 슬라이드 번호 라벨, **wikilink 클릭 이동** (Cmd-클릭 = 새 탭), **"📝 노트 편집"** 버튼으로 split-pane editor 열기 + 편집 시 우측 자동 refresh.
- **개념 네트워크**: LLM이 한국어 강의에 한국어 개념(영어 병기), 영어 강의엔 영어 개념을 추출하고, 모든 슬라이드 섹션에 걸쳐 `[[Wikilink]]`로 일관성 있게 연결합니다. 정의 3-5문장 + 강의 맥락 2-3문장 + 구체 예시 + 시험 함정.
- **안전한 재가져오기**: 변경 요약 (reorder/insert/delete/drift 카운트)을 확인한 뒤 관리 구간만 업데이트, 사용자 메모는 보존. 슬라이드의 절반 이상이 사라지면 deck-replacement 확인 모달이 뜹니다 (실수로 다른 강의 URL을 import한 경우 방지).
- **시험대비 요약본**: 과목별 강의 관계도 + 핵심 요약을 자동 생성.
- **사이드바 UI**: URL 입력, 과목 선택, 최근 노트, 시험요약본 생성을 한 곳에서 관리.
- **다중 LLM 지원**:
  - **Google AI Studio (기본)**: Gemini 2.5 Flash, **Gemma 3 27B/12B/4B** (모두 멀티모달, Gemma는 무료 등급 RPM ~30으로 더 여유). 모델명만 변경.
  - **Multi-key rotation**: API 키 필드에 콤마로 여러 무료 키 입력 → 429 시 자동 round-robin (3개 키 ≈ 15 RPM).
  - **Ollama (로컬)**: 멀티모달은 `llama3.2-vision:11b`, 텍스트는 `gemma3:4b` 권장. 무제한·무료·offline.
  - 자세한 RPM 우회 옵션: [`docs/gemini-rpm-options.md`](docs/gemini-rpm-options.md) 참고.
- **Phase 2 Skill (Claude Code Max 사용자)**: `/alt2obs <alt-url>` 명령으로 Claude Code의 native vision으로 import. Gemini 쿼터 무관, 자세히는 [`scripts/phase2/`](scripts/phase2/) 참고.

> 1.0.x → 1.1.0 마이그레이션: 기존에 import한 노트는 그대로 유지됩니다. 새로 import하는 강의부터 페이지-anchored 구조로 생성됩니다.

## 설치 방법

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

## Alt 앱에서 노트 링크 가져오는 법

Alt2Obsidian을 사용하려면 먼저 Alt 앱에서 강의 노트의 공유 링크가 필요합니다.

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

### 1단계: API 키 설정

1. [Google AI Studio](https://aistudio.google.com/apikey)에서 **무료** API 키를 발급받습니다.
   - Google 계정으로 로그인
   - "Create API Key" 클릭
   - 생성된 키 복사
   > **무료 등급으로도 충분히 사용 가능합니다.**

2. Obsidian **설정 → Alt2Obsidian**에서 API 키를 입력합니다.

### 2단계: Alt 노트 가져오기

1. 왼쪽 리본의 📖 아이콘을 클릭하여 **Alt2Obsidian 사이드바**를 엽니다.

2. [Alt](https://altalt.io) 에서 공유할 노트의 URL을 복사합니다.
   - 예: `https://www.altalt.io/en/note/0a471d1c-4ec6-4101-8de2-ccc1781770d4`

3. URL을 붙여넣고 **과목명**을 입력합니다 (예: `CSED311`).
   - 기존 과목이 있으면 칩을 클릭하여 선택 가능
   - 비워두면 자동 감지 시도

4. **"가져오기"** 버튼을 클릭합니다.

5. 잠시 후 Vault에 다음이 생성됩니다:
   ```
   Alt2Obsidian/
   ├── CSED311/
   │   ├── CSED311 Lec7-pipelined-CPU.md    ← 강의 노트 (페이지별 섹션)
   │   ├── CSED311 Lec7-pipelined-CPU.pdf   ← 원본 PDF (Synced Viewer 동작용 sibling 위치)
   │   └── Concepts/                        ← 과목별 개념 노트
   │       ├── 파이프라인 해저드 (Pipeline Hazard).md
   │       ├── 포워딩 (Forwarding).md
   │       └── ...
   └── Exam/
       └── CSED311-시험요약.md              ← 시험 요약본
   ```

### 3단계: 시험대비 요약본 생성

1. 같은 과목의 강의를 여러 개 가져온 뒤
2. 사이드바 하단의 **"시험요약본 생성"** 버튼을 클릭
3. 강의 관계도 + 핵심 요약이 포함된 시험 요약본이 자동 생성됩니다

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

마커 형식: `<!-- alt2obs:slide:N hash:<8-hex> start --> ... <!-- end -->`. 해시는 슬라이드 PNG의 SHA-1 8자리로, Alt이 슬라이드를 reorder/insert/delete해도 사용자 메모가 올바른 슬라이드에 따라가도록 보존합니다.

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
| LLM 제공자 | `Google Gemini / Gemma`, `Ollama (local)`, OpenAI/Claude (텍스트 전용 stub) | Google Gemini / Gemma |
| API 키 | Google AI Studio API 키. **콤마 구분으로 여러 키 입력하면 429 시 자동 rotation** | (직접 입력) |
| Gemini 모델 | `gemini-2.5-flash` (기본), `gemini-2.5-flash-lite` (RPD 여유), **`gemma-3-27b-it`** (무료 RPM ~30, 멀티모달, 추천 무료 사용 모델) | gemini-2.5-flash |
| Ollama endpoint | 로컬 Ollama 서버 URL (provider=ollama 일 때 노출) | http://localhost:11434 |
| Ollama 모델 | `gemma3:4b` (텍스트), `llama3.2-vision:11b` (멀티모달) | gemma3:4b |
| 저장 폴더 | Vault 내 저장 경로 | Alt2Obsidian |
| 요청 간격 | API 호출 간 대기시간(ms). 슬라이드 30+ deck면 6000+ 권장 | 4000 |
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
```

## 라이선스

[MIT License](LICENSE)

## 제작자

**BiQnT** - [GitHub](https://github.com/BiQnT)
