You are extracting the key academic concepts of a lecture for the course "{{subject}}" so the student can build a connected concept network in their Obsidian vault. The input is the per-slide gist list of the lecture, the concept names the slide commentary already linked, and the concept notes that already exist.

LANGUAGE: {{langInstruction}}

For each concept provide:
- name: concise, 1-4 words. For Korean, "한국어 (English)", matching the existing concept-note style.
- definition: 3-5 sentences: what the concept is, what makes it distinct, why it matters in this course.
- lectureContext: 2-3 sentences on how this lecture used or motivated it, citing slide numbers from the gist list.
- example: a concrete example the lecture used, or "" if there was none.
- caution: a common mistake or exam trap, or "" if you cannot identify one.
- relatedConcepts: exact names from your list or the existing list. With 2 or more concepts, every concept has at least one.

QUALITY BAR:
- 4-8 concepts for a typical lecture. Do not pad.
- Prefer the linked names below; reuse existing concept-note names exactly when the same concept appears.
- tags: lowercase, hyphenated, English-only keywords. Reuse the existing subject tags when they fit.

KOREAN STYLE (when the fields are Korean; every rule is checked):
1. Every field ends its sentences in "~다" (해라체). No "~합니다", no "~요".
2. Cite slides as "슬라이드 5" or "슬라이드 9~10" (p.N in the gist list is slide N). Never write "p.5".
3. Inside Korean sentences use the Korean term (English only in the concept name). Keep established loanwords (타임 슬라이스, 스트라이드); do not coin translations (시간 조각, 보폭). Code identifiers in backticks.
4. No filler or translationese: "중요한 역할을 한다", "핵심적인", "~라는 점에서", "~를 통해", "~에 있어서", "주의해야 한다", "정당화했다". caution states the mistake and the correct fact; do not reuse one sentence frame (such as "~라고 착각하기 쉽다") across concepts.
5. lectureContext says what the lecture did, in order, with slide numbers. No narration about the professor's intent. example is about this concept itself.
Good example (one concept):
{"name":"스트라이드 스케줄링 (Stride Scheduling)","definition":"티켓 비율을 무작위성 없이 정확히 맞추는 비례 배분 스케줄링이다. 프로세스마다 큰 상수를 티켓 수로 나눈 stride를 두고, 실행할 때마다 pass 값에 stride를 더한다. 스케줄러는 pass 값이 가장 작은 프로세스를 고른다.","lectureContext":"슬라이드 16~17에서 stride와 pass 값을 정의하고, 슬라이드 18~19에서 세 프로세스의 실행 순서를 표로 따라간다. 슬라이드 20에서 새 프로세스의 pass 초기값 문제를 로터리 스케줄링과 비교한다.","example":"티켓이 A=100, B=50, C=250이면 stride는 100, 200, 40이고, 한 주기 동안 C 5회, A 2회, B 1회 실행된다.","caution":"stride와 실행 빈도를 정비례로 외우면 틀린다. stride는 티켓 수에 반비례하므로 stride가 작은 프로세스가 더 자주 실행된다.","relatedConcepts":["로터리 스케줄링 (Lottery Scheduling)","티켓 (Ticket)"]}
{{existingConceptHint}}
Existing subject tags: {{subjectTags}}

Concept names linked in the slide commentary:
{{linkCandidates}}

Per-slide gists:
{{gists}}

Return a JSON object: {"concepts":[{"name":"...","definition":"...","lectureContext":"...","example":"...","caution":"...","relatedConcepts":["..."]}],"tags":["..."]}
