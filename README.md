# Alt2Obsidian

Alt(altalt.io) 강의 노트를 Obsidian에 자동으로 가져오는 플러그인입니다.

LLM(Gemini)을 활용하여 강의 내용을 정리하고, 핵심 개념을 `[[Wikilink]]`와 `#태그`로 네트워크화하며, 시험대비 요약본을 자동 생성합니다.

## 주요 기능

- **Alt 노트 가져오기**: Alt URL만 입력하면 요약 + 슬라이드 이미지가 포함된 마크다운 노트 자동 생성
- **개념 네트워크**: LLM이 핵심 개념을 추출하여 별도 노트 + `[[Wikilink]]` + `#태그`로 연결
- **시험대비 요약본**: 과목별 강의 관계도 + 핵심 요약을 자동 생성
- **사이드바 UI**: URL 입력, 과목 선택, 최근 노트, 시험요약본 생성을 한 곳에서 관리
- **다중 LLM 지원**: Gemini (기본), OpenAI, Claude 인터페이스 준비 (추상화 구조)

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

### 방법 2: 커뮤니티 플러그인 (등록 후)

1. **설정 → 커뮤니티 플러그인 → 탐색**에서 "Alt2Obsidian"을 검색합니다.
2. **설치** → **활성화**를 클릭합니다.

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
   │   └── assets/
   │       ├── csed311_lec7-pipelined-cpu_slide_01.png
   │       ├── csed311_lec7-pipelined-cpu_slide_02.png
   │       └── ...
   ├── Concepts/
   │   ├── Pipeline Hazard.md               ← 개념 노트
   │   ├── Forwarding.md
   │   └── ...
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

# CSED311 Lec7-pipelined-CPU

## 개요
- **파이프라인**은 복수의 명령어를 동시에 서로 다른 단계에서 실행해
  [[Pipeline Hazard]]를 고려하면서 처리량을 높이는 기법이다.

![[csed311_lec7_slide_01.png]]

## Pipeline Stages
...
```

### 개념 노트
```markdown
---
tags: [concept]
---

# Pipeline Hazard

**정의:** 파이프라인에서 다음 명령어 실행이 방해되는 상황

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
