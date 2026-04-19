---
name: loop
description: "Use when the user explicitly asks for a looped, multi-round approach to a task, especially when iterative improvement, exploration, refinement, or comparison across rounds would help."
---

# Loop

A generic iterative execution framework. Repeatedly perform a task, self-verify after each iteration, and stop when the goal is achieved or the iteration cap is reached.

## Initialization

When this skill is triggered, **do not begin execution immediately**. Follow this sequence:

### 1. Gather Information

Read the conversation history to determine what the user has already established. Identify which of the following four items are already implied or stated:

| Item | Question | Required? |
|------|----------|-----------|
| **Task** | What should I do in each iteration? | Yes |
| **Goal** | What does "done" look like? | Yes |
| **Verification** | How do I check whether I did it well this round? | Yes |
| **Max iterations** | How many rounds at most? | No (default: 5) |

Also note any constraints the user has mentioned (boundaries, things to avoid, style requirements, etc.).

### 2. Confirm Understanding

Present your understanding to the user in a concise format:

```
📋 My understanding:
- Task: <one-line summary>
- Goal: <one-line summary>
- Verification: <one-line summary>
- Max iterations: <number>
- Constraints: <if any, otherwise "none">
```

Ask: **"Is this correct?"**

### 3. Fill Gaps

If any required item is missing from the conversation history, ask the user specifically for that item. Do not ask about items you can already infer with confidence.

If the user corrects your understanding, update and re-confirm before proceeding.

### 4. Get Explicit Go

After the user confirms everything is correct, ask for one final explicit confirmation:

> Ready to start. Proceed?

Only begin execution after the user says yes.

## Execution Loop

```
[Iteration 1] → [Iteration 2] → ... → [Iteration N] → Report
     ↓               ↓                    ↓
  Execute         Execute              Execute
  Verify          Verify               Verify
  Judge           Judge                Judge
  (continue?)     (continue?)          (done)
```

Each iteration follows this sequence:

### Execute

Perform the task described by the user. Adapt approach based on what was learned in previous iterations. Reference any files or outputs created in earlier rounds.

### Reflect

After executing, pause and reflect before deciding what to do next. Reflection should stay lightweight, but it should cover three questions:

- Where am I most likely misunderstanding the user's real intent?
- What part of the current result feels weakest, thinnest, or least convincing?
- If I continue, what would be the most useful adjustment in approach?

The purpose of reflection is not ritual. It is to increase the chance that later rounds move closer to what the user actually wants.

### Shift Perspective

Before the next round, consider the current result from a different angle instead of staying locked into one path. This does not need to be rigid or theatrical. It is a prompt to widen reasoning when useful.

Possible perspectives include:

- User view: What would matter most to the person receiving this?
- Critic view: What would an informed skeptic say is weak, unclear, or unconvincing?
- Minimalist view: What is extra, noisy, or not pulling its weight?
- Completeness view: What is missing, underdeveloped, or not yet addressed?
- Alternative-path view: If I did not continue in the current direction, what other route could work?

Not every task needs a dramatic perspective shift every round. The point is to avoid single-path dependence and notice options the current trajectory is hiding.

### Compare Across Rounds

Compare the current round with the previous round before deciding whether the loop is paying off.

- What meaningfully improved?
- What only changed in wording or presentation without adding real value?
- What got worse, narrowed, or drifted off target?

This comparison is what turns multiple rounds into learning instead of repetition.

### Verify

After reflecting and comparing, evaluate the current result against the verification criteria the user specified. This is a self-check — read, review, test, or reason about the output to determine quality.

### Judge

Decide one of:

- **Pass** — The goal is achieved. Exit the loop and generate the final report.
- **Continue** — Improved but not yet at goal. Proceed to next iteration.
- **Stuck** — No meaningful progress compared to the previous iteration. Note this in the round report but continue up to the cap.

### Per-Iteration Report

After each iteration, output a brief status:

```
--- Round <N>/<max> ---
Status: Pass / Continue / Stuck
What I did: <brief summary>
Reflection: <most likely misread / weakest point / best next adjustment>
Perspective: <which angle shaped this round, if any>
Comparison: <what improved vs last round / what did not>
What I found: <verification observations>
Next move: <what I would change next if continuing>
```

Keep per-iteration reports concise. One to three sentences per field.

## Final Report

When the loop exits (either by passing or hitting the cap), generate a final report:

```
╔══════════════════════════════╗
║        LOOP COMPLETE         ║
╠══════════════════════════════╣
║ Total iterations: <N>        ║
║ Result: <Passed / Cap reached>║
╠══════════════════════════════╣
║ Summary:                     ║
║ <2-3 sentence overview>      ║
╠══════════════════════════════╣
║ Iteration history:           ║
║ Round 1: <one line>          ║
║ Round 2: <one line>          ║
║ ...                          ║
╠══════════════════════════════╣
║ Remaining issues (if any):   ║
║ <list what's still not ideal>║
╚══════════════════════════════╝
```

## Safety Boundaries

- Only read and write files within the workspace directory.
- Do not delete files unless the user explicitly requested it as part of the task.
- If the user sends a message during the loop, treat it as an interruption: pause, address the user, then ask whether to continue the loop.

## Loop Patterns

Different tasks benefit from different looping strategies. After initialization, read [references/patterns.md](references/patterns.md) to identify which pattern best matches the user's task and adapt the execution accordingly.

## Troubleshooting

If the loop is not progressing well (stuck, degrading, or drifting), consult [references/troubleshooting.md](references/troubleshooting.md) for recovery strategies.
