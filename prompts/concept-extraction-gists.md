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
{{existingConceptHint}}
Existing subject tags: {{subjectTags}}

Concept names linked in the slide commentary:
{{linkCandidates}}

Per-slide gists:
{{gists}}

Return a JSON object: {"concepts":[{"name":"...","definition":"...","lectureContext":"...","example":"...","caution":"...","relatedConcepts":["..."]}],"tags":["..."]}
