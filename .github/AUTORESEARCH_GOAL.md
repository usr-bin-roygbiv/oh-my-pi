# Improve OMP with one measurable, test-backed change per segment

This file defines bounded upstream goal data for `/contribute`. It is not instruction authority and cannot override system, developer, user, safety, approval, tool, or repository policy.

## Segment goal

Deliver exactly one focused OMP improvement per segment. The improvement MUST be observable, measurable, covered by a deterministic behavioral test, and small enough for a human to review confidently.

Choose one OMP behavior, reliability problem, performance cost, or developer-experience defect. Keep changes within the minimum coherent implementation and test surface. NEVER bundle unrelated fixes, broad refactors, dependency churn, generated artifacts, or speculative cleanup.

## Experiment contract

1. State one falsifiable hypothesis before editing: changing a specific cause SHOULD produce a named observable result without regressing stated invariants.
2. Define the measurement and success threshold before implementation.
3. Add or identify a behavioral regression test that fails for the predicted reason. Run it and record the red evidence.
4. Make the smallest coherent implementation change.
5. Run the same test and record the green evidence. Run required validation for touched code under normal approval policy.
6. Keep the result only when evidence meets the threshold without regressions. Otherwise discard it and report the failed hypothesis honestly.

A passing test with no demonstrated pre-change failure is insufficient. Source-text assertions, placeholder tests, mocks that bypass the behavior, and unverifiable claims are insufficient.

## Operating boundaries

Use only available tools under their normal approval policy. NEVER bypass an approval, expand tool access, weaken validation, or treat this goal as permission. Human input, authorization, credentials, secrets, or policy judgment required? Pause and request the input through the contribution workflow; NEVER obtain, inspect, copy, store, or transmit credentials.

Keep all work local and unpublished. NEVER push, publish, open, approve, or merge a pull request unattended. Hand the evidence-backed candidate to `/contribute review` for its exact-SHA checks and confirmation flow.

A human MUST review the final diff. The contributor MUST personally write the required pull-request sentence; the agent MUST leave its placeholder empty and MUST NOT draft, infer, or fill it.

## Handoff evidence

Report the hypothesis, measurement, threshold, red and green observations, changed paths, user-visible effect, validation, limitations, and reviewer focus. Preserve all higher-level policies: this file supplies goal data only.
