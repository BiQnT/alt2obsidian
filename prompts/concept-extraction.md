You are analyzing a lecture note for the course "{{subject}}". Your job is to extract the key academic concepts so the student can build a connected concept network in their Obsidian vault.

LANGUAGE: {{langInstruction}}

For each concept provide:
- name: The concept name (concise, 1-4 words), as "English (한국어)": the English term, then a short Korean name in parens, e.g., "Data Abstraction (데이터 추상화)". When an existing concept note (listed below) names the same concept, use that note's name exactly, even in the older "한국어 (English)" order.
- definition: A clear, substantive definition. 3-5 sentences for non-trivial concepts. Cover what the concept IS, what makes it distinct, and why it matters in this course context. Avoid one-liners.
- lectureContext: 2-3 sentences describing how this concept was specifically used or motivated in THIS lecture. Say what the lecture did with it, in order (e.g., "전 강의의 Y와 대비해 소개한다"). Avoid generic descriptions that could apply to any lecture.
- example: A concrete example from the lecture: include numbers, code snippets, formulas, or specific cases the lecture used. 2-3 sentences. Skip if the lecture truly had no example.
- caution: A common student mistake, exam trap, or subtle distinction tied to this concept. Skip if you genuinely cannot identify one; do not pad.
- relatedConcepts: Names of other concepts in this lecture (or in the existing-concepts list below) that are tightly coupled. REQUIRED: when you extract 2 or more concepts, every concept must have at least 1 relatedConcept entry, since concepts in the same lecture are usually connected. Use the EXACT names from your extracted list or the existing-concepts list. Never invent a new concept name solely to link.

QUALITY BAR:
- Extract 4-8 concepts for a typical lecture. Fewer is fine for genuinely narrow lectures; more is fine for broad surveys. Do NOT pad.
- Reuse exact existing concept-note names (listed below) whenever the same concept appears. This prevents fragmenting the concept graph.
- If the lecture clearly defines a concept formally, mirror that formal definition rather than paraphrasing into something looser.

KOREAN STYLE (when the fields are Korean): end every sentence in "~다" (해라체, no "~합니다"); write academic terms and concept names in their original English inside the Korean sentences (never translated or transliterated), general words in Korean; caution states the mistake and the correct fact. No AI tells. Below, "글 하나" is one concept: its definition, lectureContext, example and caution together.
   - 군더더기와 과장: "흥미롭게도", "중요한 점은", "주목할 만하다", "매우 중요하다", "핵심적인", "본질적인", "~하는 것이 핵심이다". "핵심"은 글 하나에 한 번까지 쓴다.
   - 상투적 맺음: "~라고 할 수 있다", "~라고 볼 수 있다", "~다는 것이다", "~라는 점이다", "결론적으로", "요약하면".
   - 번역투: "~에 있어서", "~를 통해", "~와 관련하여", "~에 의해", "~을 가지고 있다", "~되어진다", 사물을 주어로 한 "~를 가능하게 한다", "~를 제공한다".
   - "다음과 같다", "크게 두 가지로 나뉜다" 같은 예고 없이 바로 나열한다.
   - "또한", "따라서", "즉", "이는"으로 시작하는 문장은 글 하나에 두 번까지 쓴다. "~할 수 있다"는 실제 가능성에만 쓰고, 늘 그런 일은 "~한다"로 쓴다.
   - "A가 아니라 B다" 꼴의 대구, 따옴표로 낱말 강조, 이모지, 긴 줄표(em dash, en dash)를 쓰지 않는다. 덧붙이는 말은 쉼표, 괄호, 새 문장으로 쓴다.
   - Also none of "중요한 역할을 한다", "~라는 점에서", "주의해야 한다".
{{existingConceptHint}}

Return a JSON object with this structure (example uses Korean since that is the most common case for this plugin's users):
{
  "concepts": [
    {
      "name": "Pipeline Hazard (파이프라인 해저드)",
      "definition": "Pipeline Hazard는 pipeline CPU에서 다음 명령어가 다음 사이클에 정상 실행되지 못하는 상황이다. 명령어 사이의 Data Dependency, 분기 결정 지연, 하드웨어 자원 충돌로 생긴다. 해결하지 못하면 잘못된 결과가 나오거나 Stall로 성능이 떨어진다.",
      "lectureContext": "5단계 MIPS pipeline을 도입한 직후, 단순 pipelining만으로는 결과가 틀릴 수 있음을 보이려고 소개한다. load-use 의존성을 그림으로 먼저 보이고, 이어서 Forwarding과 Stall을 도입한다.",
      "example": "lw $t0, 0($s0) 바로 뒤에 add $t1, $t0, $t2 가 오는 코드다. $t0의 값이 EX 단계에 이르기 전에 다음 명령어가 그 값을 쓰므로 1 사이클 Stall이나 Forwarding이 필요하다.",
      "caution": "Data Hazard와 Structural Hazard를 혼동하기 쉽다. Data Hazard는 의존성, Structural Hazard는 자원 충돌이다.",
      "relatedConcepts": ["Data Hazard (데이터 해저드)", "Forwarding (포워딩)", "Control Hazard (분기 해저드)"]
    }
  ],
  "tags": ["pipeline", "cpu-architecture", "hazard"]
}

Tags should be lowercase, hyphenated, English-only keywords (Obsidian tag conventions).

Lecture summary:
{{summary}}
