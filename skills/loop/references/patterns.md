# Loop Patterns

Three fundamental looping strategies. Identify which one matches the user's task during initialization.

## 1. Refinement Loop (逐轮精炼)

**Best for:** Editing, polishing, translating, optimizing — tasks where you improve the *same* output across rounds.

**Behavior:**
- Each iteration works on the same artifact(s).
- Changes are incremental: fix specific issues found during verification.
- Later iterations produce diminishing returns — this is expected.
- Perspective shifts are usually evaluative rather than radical: the user view, critic view, minimalist view, or completeness view often help more than inventing a brand-new direction.

**Verification tip:** Compare the current version against the previous version. If nothing meaningfully changed, mark as Stuck.

**Example tasks:**
- "Polish this essay until it reads naturally"
- "Refine the translation for accuracy and fluency"
- "Optimize this plan for clarity and completeness"

## 2. Accumulation Loop (累积构建)

**Best for:** Research, multi-part generation, survey writing — tasks where each round produces *new* content that builds on previous rounds.

**Behavior:**
- Each iteration produces new artifacts or adds to existing ones.
- Progress is measured by coverage, not by per-artifact quality.
- Intermediate outputs are themselves useful deliverables.

**Verification tip:** Check what is still missing or incomplete, not what needs fixing.

**Example tasks:**
- "Research all major subtopics of X and summarize each"
- "Write section by section, ensuring each connects to the previous"
- "Generate one design concept per round, then compare all"

**Practical guidance:**
- The workspace naturally serves as the accumulation log — each round's output is a file or section.
- A summary index file (e.g. `progress.md`) helps the agent track what's been covered and what's next.
- Do not create a separate "log file" unless the task explicitly calls for one. The work products themselves are the record.
- Perspective shifts here usually mean changing coverage priorities: what is still missing, what is underexplored, and what deserves deeper treatment next.

## 3. Exploration Loop (分支探索)

**Best for:** Brainstorming, comparison, creative tasks — tasks where each round tries a *different approach* rather than iterating on one.

**Behavior:**
- Each iteration explores a distinct variant, direction, or hypothesis.
- No single round is "better" — the value emerges from comparing across rounds.
- The final round synthesizes or selects from all variants.
- Perspective shifts are central here: each round should look at the task through a meaningfully different lens, not just restate the same idea in new words.

**Verification tip:** Each round's verification is whether the variant is coherent and complete, not whether it's "the best."

**Example tasks:**
- "Try 3 different writing styles for this article"
- "Explore different architectures for this system"
- "Generate alternative solutions and compare trade-offs"

**Practical guidance:**
- Number or label each variant clearly (Option A, Option B...).
- In the final report, present a comparison rather than a single winner (unless the user asked to pick one).
- If the max iterations is reached before exploring enough directions, suggest which directions remain unexplored.
- Good perspective sources include audience, values, constraints, trade-offs, structure, tone, and alternative solution paths.

## Choosing a Pattern

During initialization, match based on the user's task description:

| Signal in user's task | Pattern |
|-----------------------|---------|
| "improve", "polish", "refine", "fix" | Refinement |
| "research", "each part", "section by section", "one per round" | Accumulation |
| "try different", "compare", "alternatives", "explore" | Exploration |
| Ambiguous | Ask the user, or default to Refinement |

A task can blend patterns. For example: accumulate research across rounds, then refine the final synthesis. If so, state the hybrid approach in the initialization confirmation.

Across all patterns, perspective shifting should stay useful rather than ceremonial. The goal is not to perform a different persona each round. The goal is to loosen single-path thinking and surface insights the current approach may be missing.
