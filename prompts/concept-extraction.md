You are analyzing a lecture note for the course "{{subject}}". Your job is to extract the key academic concepts so the student can build a connected concept network in their Obsidian vault.

LANGUAGE: {{langInstruction}}

For each concept provide:
- name: The concept name (concise, 1-4 words). For Korean, use the Korean name with the English in parens, e.g., "데이터 추상화 (Data Abstraction)" — pattern: "한국어 (English)". Match the existing concept-note style listed below.
- definition: A clear, substantive definition. 3-5 sentences for non-trivial concepts. Cover what the concept IS, what makes it distinct, and why it matters in this course context. Avoid one-liners.
- lectureContext: 2-3 sentences describing how this concept was specifically used or motivated in THIS lecture. Say what the lecture did with it, in order (e.g., "전 강의의 Y와 대비해 소개한다"). Avoid generic descriptions that could apply to any lecture.
- example: A concrete example from the lecture — include numbers, code snippets, formulas, or specific cases the lecture used. 2-3 sentences. Skip if the lecture truly had no example.
- caution: A common student mistake, exam trap, or subtle distinction tied to this concept. Skip if you genuinely cannot identify one — do not pad.
- relatedConcepts: Names of other concepts in this lecture (or in the existing-concepts list below) that are tightly coupled. REQUIRED: when you extract 2 or more concepts, every concept must have at least 1 relatedConcept entry — concepts in the same lecture are usually connected. Use the EXACT names from your extracted list or the existing-concepts list. Never invent a new concept name solely to link.

QUALITY BAR:
- Extract 4-8 concepts for a typical lecture. Fewer is fine for genuinely narrow lectures; more is fine for broad surveys. Do NOT pad.
- Reuse exact existing concept-note names (listed below) whenever the same concept appears — this prevents fragmenting the concept graph.
- If the lecture clearly defines a concept formally, mirror that formal definition rather than paraphrasing into something looser.

KOREAN STYLE (when the fields are Korean): end every sentence in "~다" (해라체, no "~합니다"); use the Korean term inside sentences (English only in the concept name); no filler or translationese ("중요한 역할을 한다", "핵심적인", "~라는 점에서", "~를 통해", "~에 있어서", "주의해야 한다"); caution states the mistake and the correct fact.
{{existingConceptHint}}

Return a JSON object with this structure (example uses Korean since that is the most common case for this plugin's users):
{
  "concepts": [
    {
      "name": "파이프라인 해저드 (Pipeline Hazard)",
      "definition": "파이프라인된 CPU에서 다음 명령어가 다음 사이클에 정상 실행되지 못하게 하는 상황을 말한다. 명령어 간 데이터 의존성, 분기 결정 지연, 또는 하드웨어 자원 충돌로 발생한다. 해저드를 해결하지 못하면 잘못된 결과가 나오거나 stall로 성능이 떨어진다. 컴퓨터 구조 수업의 핵심 평가 포인트 중 하나다.",
      "lectureContext": "이번 강의에서는 5단계 MIPS 파이프라인을 도입한 직후, 단순 파이프라이닝만으로는 정합성이 깨질 수 있다는 점을 보이기 위해 도입되었다. 교수님은 load-use 의존성을 가장 먼저 그림으로 보여주고, 이를 발판으로 forwarding과 stall 메커니즘 도입을 정당화했다.",
      "example": "lw $t0, 0($s0)  바로 뒤에 add $t1, $t0, $t2 가 오는 코드. $t0의 값이 EX 단계에 도달하기 전 다음 명령어가 그 값을 필요로 하므로 1 사이클 stall 또는 forwarding이 필요하다.",
      "caution": "데이터 해저드(Data Hazard)와 구조 해저드(Structural Hazard)를 혼동하기 쉽다. 데이터 해저드는 의존성, 구조 해저드는 자원 충돌이다. 시험에서는 분기 해저드(Control Hazard)도 자주 같이 나온다.",
      "relatedConcepts": ["데이터 해저드 (Data Hazard)", "포워딩 (Forwarding)", "분기 해저드 (Control Hazard)"]
    }
  ],
  "tags": ["pipeline", "cpu-architecture", "hazard"]
}

Tags should be lowercase, hyphenated, English-only keywords (Obsidian tag conventions).

Lecture summary:
{{summary}}
