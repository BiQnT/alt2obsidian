# Alt2Obsidian

Alt(altalt.io) 강의 노트를 Obsidian에 자동으로 가져오는 플러그인입니다.

LLM(Gemini)을 활용하여 강의 슬라이드 1장당 한국어 해설을 만들고, 핵심 개념을 `[[Wikilink]]`와 `#태그`로 네트워크화하며, PDF와 노트를 좌우 동기 스크롤로 보여주는 전용 뷰어를 제공합니다.

## 주요 기능 (1.1.0)

- **페이지-anchored 노트 구조**: 강의 1개당 1 .md 파일에 PDF 슬라이드와 1:1로 대응하는 `## 📚 슬라이드 N` 섹션 자동 생성. 각 섹션 안의 Gemini 해설은 슬라이드 이미지 + 해당 구간 음성 전사 발췌를 입력으로 한 번씩 호출되어 만들어집니다.
- **사용자 메모 안전 보존**: 슬라이드별 `> [!note] 내 메모` 콜아웃은 관리 블록 바깥에 위치하며, 다음 import 때도 그대로 유지됩니다 (해시-augmented 마커가 슬라이드 reorder/insert/delete를 감지해 재정렬).
- **Synced Viewer**: 명령 팔레트에서 'Open Synced Viewer (PDF + lecture .md)'를 실행하면 PDF(좌)와 강의 노트(우)가 좌우로 떠오르고, PDF 페이지를 넘기면 노트가 해당 슬라이드 섹션으로 자동 스크롤됩니다. 텍스트 선택과 zoom 지원.
- **개념 네트워크**: LLM이 핵심 개념을 추출하고, 모든 슬라이드 섹션에 걸쳐 `[[Wikilink]]`로 일관성 있게 연결합니다.
- **안전한 재가져오기**: 변경 요약 (reorder/insert/delete/drift 카운트)을 확인한 뒤 관리 구간만 업데이트, 사용자 메모는 보존. 슬라이드의 절반 이상이 사라지면 deck-replacement 확인 모달이 뜹니다 (실수로 다른 강의 URL을 import한 경우 방지).
- **시험대비 요약본**: 과목별 강의 관계도 + 핵심 요약을 자동 생성.
- **사이드바 UI**: URL 입력, 과목 선택, 최근 노트, 시험요약본 생성을 한 곳에서 관리.
- **다중 LLM 지원**: Gemini (기본, 멀티모달 슬라이드 호출 사용), OpenAI / Claude 인터페이스는 텍스트 전용 — 멀티모달이 필요하면 Gemini를 사용하세요.

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
   │   ├── CSED311 Lec7-pipelined-CPU.md    ← 강의 노트
   │   ├── assets/
   │   │   └── CSED311 Lec7-pipelined-CPU.pdf
   │   └── Concepts/                        ← 과목별 개념 노트
   │       ├── Pipeline Hazard.md
   │       ├── Forwarding.md
   │       └── ...
   └── Exam/
       └── CSED311-시험요약.md              ← 시험 요약본
   ```

### 3단계: 시험대비 요약본 생성

1. 같은 과목의 강의를 여러 개 가져온 뒤
2. 사이드바 하단의 **"시험요약본 생성"** 버튼을 클릭
3. 강의 관계도 + 핵심 요약이 포함된 시험 요약본이 자동 생성됩니다

## 생성되는 노트 구조

### 강의 노트
```markdown
---
title: "CSED311 Lec7-pipelined-CPU"
subject: "CSED311"
tags: [csed311, pipeline, cpu-architecture, hazard]
date: "2026-03-25"
---

<!-- alt2obsidian:start -->
# CSED311 Lec7-pipelined-CPU

## 개요
- **파이프라인**은 복수의 명령어를 동시에 서로 다른 단계에서 실행해
  [[Pipeline Hazard]]를 고려하면서 처리량을 높이는 기법이다.

## Pipeline Stages
...
<!-- alt2obsidian:end -->

## 내 메모
```

### 개념 노트
```markdown
---
tags: [concept]
---

# Pipeline Hazard

**정의:** 파이프라인에서 다음 명령어 실행이 방해되는 상황

**강의 맥락:** 파이프라인 CPU에서 stall과 forwarding이 필요한 이유를 설명할 때 사용됨
**예시:** load-use dependency가 바로 다음 명령어를 지연시킬 수 있음
**주의:** data hazard와 structural hazard를 구분해야 함

**관련 강의:** [[CSED311 Lec7-pipelined-CPU]]
**관련 개념:** [[Data Hazard]], [[Forwarding]]
```

## 설정

| 설정 | 설명 | 기본값 |
|------|------|--------|
| LLM 제공자 | 사용할 LLM 서비스 | Google Gemini |
| API 키 | LLM API 키 | (직접 입력) |
| Gemini 모델 | 사용할 모델명 | gemini-2.5-flash |
| 저장 폴더 | Vault 내 저장 경로 | Alt2Obsidian |
| 요청 간격 | API 호출 간 대기시간(ms) | 4000 |

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
