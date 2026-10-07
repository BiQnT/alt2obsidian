You are extracting the key academic concepts of a lecture for the course "{{subject}}" so the student can build a connected concept network in their Obsidian vault. The lecture was recorded without slides. The input is the one-line gist of each time section of its transcript, the concept names the section summaries already linked, and the concept notes that already exist.

LANGUAGE: {{langInstruction}}

For each concept provide:
- name: concise, 1-4 words, as "English (한국어)": the term in its original English, then a short Korean name, e.g. "Lottery Scheduling (로터리 스케줄링)". When an existing concept note names the same concept, use that note's name exactly, even in the older "한국어 (English)" order.
- definition: 3-5 sentences: what the concept is, what makes it distinct, why it matters in this course.
- lectureContext: 2-3 sentences on how this lecture used or motivated it, citing section numbers from the gist list.
- example: a concrete example the lecture used, or "" if there was none.
- caution: a common mistake or exam trap, or "" if you cannot identify one.
- relatedConcepts: exact names from your list or the existing list. With 2 or more concepts, every concept has at least one.

QUALITY BAR:
- 4-8 concepts for a typical lecture. Do not pad. A section gist from speech recognition can hold misheard words: use only concepts the gists make clear.
- Prefer the linked names below; reuse existing concept-note names exactly when the same concept appears (match on the English part or the Korean part, in either order).
- tags: lowercase, hyphenated, English-only keywords. Reuse the existing subject tags when they fit.

KOREAN STYLE (when the fields are Korean; every rule is checked):
1. Every field ends its sentences in "~다" (해라체). No "~합니다", no "~요".
2. Cite sections as "구간 3" or "구간 2~3". Never write "p.3" or "슬라이드".
3. Inside Korean sentences write academic terms and concept names in their original English (Lottery Scheduling, Context Switch, vruntime); never translate or transliterate them (not 로터리 스케줄링, 문맥 교환). General words, and basic words such as 프로세스 or 스케줄러, stay Korean. Code identifiers in backticks.
4. No filler or translationese: "중요한 역할을 한다", "핵심적인", "~라는 점에서", "~를 통해", "~에 있어서", "주의해야 한다", "정당화했다". No em dash or en dash: use a comma, parentheses or a new sentence. caution states the mistake and the correct fact; do not reuse one sentence frame (such as "~라고 착각하기 쉽다") across concepts.
5. lectureContext says what the lecture did, in order, with section numbers. No narration about the professor's intent. example is about this concept itself.
Good example (one concept, from another course):
{"name":"Binary Search (이진 탐색)","definition":"Binary Search는 정렬된 배열에서 찾는 범위를 매번 절반으로 줄여 값을 찾는 알고리즘이다. 가운데 원소 `mid`와 목표값을 비교해 `low`나 `high`를 옮긴다. 비교 횟수는 O(log n)이다.","lectureContext":"구간 1에서 Linear Search의 비교 횟수를 보인 뒤, 구간 2에서 범위를 반으로 줄이는 과정을 예로 따라간다. 구간 3에서 정렬되지 않은 배열에는 쓸 수 없다고 정리한다.","example":"배열 [3, 8, 15, 21, 42]에서 21을 찾으면 `mid`가 15, 21 순서로 바뀌어 비교 두 번 만에 찾는다.","caution":"정렬되지 않은 배열에 적용하면 있는 값도 못 찾는다. 탐색 전에 정렬이 되어 있어야 한다.","relatedConcepts":["Linear Search (순차 탐색)"]}
{{existingConceptHint}}
Existing subject tags: {{subjectTags}}

Concept names linked in the section summaries:
{{linkCandidates}}

Per-section gists:
{{gists}}

Return a JSON object: {"concepts":[{"name":"...","definition":"...","lectureContext":"...","example":"...","caution":"...","relatedConcepts":["..."]}],"tags":["..."]}
