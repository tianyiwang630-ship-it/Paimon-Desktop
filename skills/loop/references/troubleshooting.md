# Troubleshooting

Recovery strategies when the loop is not progressing as expected.

## Stuck: No Meaningful Progress

**Symptom:** Consecutive iterations produce identical or near-identical outputs. The verification step finds the same issues every round.

**Diagnosis:** Either the task has reached its practical limit, or the execution approach is not capable of addressing the remaining issues.

**Recovery:**
1. Mark the round as Stuck.
2. Before changing the whole approach, try changing perspective: user view, critic view, minimalist view, completeness view, or an alternative-path view.
3. If a different perspective still produces no meaningful improvement, then try a fundamentally different approach rather than incremental tweaks.
4. If still stuck after 2 consecutive Stuck rounds, exit the loop early and report what was achieved versus what remains unresolved.
5. Do not silently continue burning iterations with no progress.

## Premature Pass: False Positive

**Symptom:** The loop exits early because the agent judged the goal as met, but the result is clearly insufficient.

**Prevention:**
- During verification, explicitly re-read the user's goal statement and check each aspect.
- Ask: "If I were the user, would I accept this as done?"
- Be conservative — when in doubt, continue one more round.
- Use comparison, not confidence, as the main signal. A round that feels polished but is not materially better than the previous one is not strong evidence for Pass.

**Recovery:** Since the loop has already exited, this can only be addressed by the user requesting another loop run. Mention in the final report if confidence in the pass judgment was low.

## Context Exhaustion

**Symptom:** Output quality degrades in later iterations. The agent loses track of details from earlier rounds or starts contradicting itself.

**Diagnosis:** The conversation has grown too long for reliable reasoning.

**Prevention:**
- Keep per-iteration reports concise (1-3 sentences per field).
- For Accumulation loops, rely on workspace files as the source of truth rather than conversation history.
- When approaching the iteration cap, summarize the state in a single paragraph before executing the next round.

**Recovery:**
1. Write a compact state summary to a workspace file: what has been done, what remains, key decisions made.
2. If quality is actively degrading, exit the loop and report. The user can start a fresh loop with the summary file as context.

## Scope Creep

**Symptom:** Each iteration expands the task beyond what the user originally asked for. The output grows in ways the user did not request.

**Diagnosis:** The agent is conflating "improve" with "add more."

**Prevention:**
- During initialization, note the explicit boundaries and constraints.
- Before each iteration, re-read the goal statement. Ask: "Does what I'm about to do serve the stated goal, or am I expanding scope?"

**Recovery:**
1. Revert to the last output that was within scope.
2. In the verification step, explicitly check for scope adherence alongside quality.
3. If scope creep persists, narrow the execution focus for remaining rounds.

## False Progress

**Symptom:** Later rounds are active and verbose, but the work is not actually improving. The agent is rephrasing, reorganizing, or embellishing without adding insight.

**Diagnosis:** The loop is producing motion without learning. This often happens when comparison across rounds is too shallow.

**Prevention:**
- Ask what became clearer, more accurate, more complete, or more useful compared with the last round.
- Treat "same content, better phrasing" as a small gain unless the task is explicitly about style or polish.
- If the current round cannot point to a concrete improvement, be willing to mark it as Stuck.

**Recovery:**
1. Name the missing gain explicitly: accuracy, depth, breadth, clarity, fit to user intent, or novelty.
2. Choose the next round based on that missing gain instead of continuing by inertia.
3. If no meaningful gain seems available, stop early and report the limit honestly.

## Cascade Failure

**Symptom:** An error or bad decision in one round causes all subsequent rounds to compound the problem (e.g., a wrong interpretation that gets built upon).

**Prevention:**
- In Accumulation loops, each new piece should be independently verifiable.
- Before building on previous output, briefly sanity-check that the foundation is sound.

**Recovery:**
1. Identify which round introduced the error.
2. Rewind to the state before that round.
3. Re-execute from that point with a corrected approach.
4. Report the rewind in the per-iteration status.
