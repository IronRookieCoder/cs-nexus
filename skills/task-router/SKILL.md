---
name: task-router
description: Route software-development requests to the smallest sufficient workflow and configured Skill provider. Use for coding questions, research, code changes, bugs, refactors, architecture, reviews, or other development work that must be classified as simple, bug, or complex; clarify only genuine product decisions, escalate when evidence reveals risk, and require fresh verification before completion.
---

# Task Router

Act as the policy owner. Decide what process is needed and when; delegate how to perform specialized work to exactly one configured Skill provider per capability.

Stay quiet about internal labels and providers unless the route changes, a user decision is required, or a capability is unavailable. Tell the user what you are doing in ordinary task language.

## Read policy

Resolve policy configuration in this order:

1. `cs-nexus.yaml` in the current project.
2. `.cs-nexus/cs-nexus.yaml` in the current project.
3. The file named by `CS_NEXUS_CONFIG`.
4. `~/.cs-nexus/cs-nexus.yaml`, written by global `cs-nexus setup`.

Use the first file found and read its `routing`, `policy`, and `dependencies` values. Otherwise use the capabilities already available to the agent and the rules below. Never install a missing capability during an ordinary task; report the gap or use a safe native fallback.

Recognize only these user overrides:

- `auto`: choose the route from evidence.
- `fast`: prefer the light path, but do not bypass safety, required decisions, or verification.
- `deep`: force design and planning before implementation.

## Route the request

1. Understand the requested outcome and inspect relevant files, documentation, logs, and runtime state.
2. Separate unknown facts from unresolved decisions.
3. Classify the task as answer/research, simple change, bug, or complex change.
4. Select one provider for each needed capability.
5. Execute the selected path, adding on-demand capabilities only when the work requires them.
6. Escalate from simple to complex when new evidence crosses a risk boundary.
7. Gather fresh verification evidence before claiming completion.

### Resolve unknowns

- For a fact discoverable from code, docs, tools, logs, or the environment: explore and answer it yourself.
- For a decision that materially changes product behavior or architecture and cannot be inferred: invoke the configured clarification provider and wait for the user.
- Ask one decision at a time. Include a recommendation and its trade-off.

Do not ask users to choose workflow labels, task levels, providers, testing methods, or worktree strategy.

### Choose a route

Use the native answer/research path for read-only questions. Verify factual claims in proportion to their volatility and impact.

Use the simple path when the request is clear and local, follows an established pattern, avoids public contracts and migrations, has no security/billing/concurrency risk, and has an obvious verification method:

```text
Explore -> short internal plan -> edit -> verify
```

Use the bug path for regressions, failures, crashes, intermittent behavior, or unexplained incorrect results. Invoke the configured debugging provider before changing code:

```text
Reproduce -> collect evidence -> isolate root cause -> regression test -> fix -> verify
```

Do not brainstorm product alternatives for a bug unless the evidence reveals a genuine design decision.

Use the complex path when work crosses modules or services, adds a subsystem, changes architecture or a public protocol, requires a database migration, touches security/permissions/billing/user data, involves concurrency or consistency, has major trade-offs, or is difficult to verify:

```text
Explore -> design provider -> planning provider -> choose execution strategy -> execute -> review/verify
```

Choose parallel execution only when tasks are genuinely independent and have stable interfaces. Complexity alone does not justify subagents.

## Escalate on evidence

Start with the lightest route sufficient for known risk. Escalate `simple -> complex` immediately when exploration reveals a complex trigger. Preserve useful evidence and edits, pause further expansion, explain the newly discovered risk in plain language, then continue with design and planning from the current state.

Do not downgrade and re-upgrade. Do not manufacture retroactive process documents for work already completed.

## Add capabilities on demand

Treat browser automation, visual checks, TDD, code review, deployment, and similar tools as capabilities, not top-level routes. Invoke one only when the task needs it. A capability has one active provider; never stack alternative providers for the same role.

If no configured provider exists, prefer project skills, team skills, configured trusted skills, then mainstream community skills. Recommend discovery before building a reusable capability from scratch.

## Verify completion

Every route ends with fresh, relevant evidence: focused tests, type checking, linting, build output, an API call, browser behavior, screenshots, logs, or a smoke test. Match the verification scope to the claim. Do not claim completion from intent, stale output, or a narrow check that does not cover the requested outcome.

Report the outcome and material evidence. Reveal route details only when they affected the user.
