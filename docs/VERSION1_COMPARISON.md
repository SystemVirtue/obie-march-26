# Version 1 vs Professional Rebuild (Non-Destructive Plan)

## Context

This comparison uses **Version 1 (`work` branch lineage)** as the functional baseline and defines a safer modernization path that preserves operational knowledge, migration traceability, and deploy confidence.

## Executive summary

The previous rebuild attempt over-optimized for minimalism by deleting too much operational context and flattening migration history into a giant SQL file.

This revised approach keeps Version 1 as source-of-truth and applies a **phased, reversible, production-grade refinement plan**.

## What Version 1 gets right

- Real server-first architecture with Supabase as source of truth.
- Mature migration trail capturing production fixes over time.
- Rich incident/deployment documentation for historical context.
- Working app triplet (admin/player/kiosk) with shared contracts.

## Gaps in Version 1

1. **Documentation sprawl:** many overlapping status files, hard to identify canonical runbooks.
2. **Operational entrypoint ambiguity:** root onboarding path is not opinionated enough.
3. **Quality gates not centralized:** no single CI-style command path for local pre-merge checks.
4. **Migration lifecycle policy missing:** many migrations exist, but squash/archive cadence is undocumented.

## Revised rebuild principles

1. **No destructive cleanup first.** Defer deletion until replacement docs and ownership are established.
2. **Keep migration history in-repo.** Add explicit policy before introducing squashed baselines.
3. **Promote canonical docs, archive gradually.** Move old reports into `docs/archive/` in follow-up PRs.
4. **Prefer additive refactors.** Every structural change should be easy to rollback.

## Implementation plan (phased)

### Phase 1 — Stabilize developer ergonomics (safe)
- Add canonical docs index and "start here" path.
- Add top-level `quality` script (typecheck + build + selected smoke tests).
- Keep all current migrations and reports untouched.

### Phase 2 — Documentation consolidation (low risk)
- Mark canonical docs with clear status (`active`, `historical`, `superseded`).
- Move one-off reports into `docs/archive/` with date prefixes.
- Keep searchable references from root README.

### Phase 3 — Migration governance (controlled)
- Define migration retention policy by release.
- Introduce optional squashed baseline per major/minor release tag.
- Preserve full historical chain in `supabase/migrations/history/` or release artifacts.

### Phase 4 — Runtime hardening (code-focused)
- Add deterministic health probes for player heartbeat/queue progress.
- Add incident playbooks tied to concrete SQL/RPC verification commands.
- Expand CI checks for app-by-app typecheck/build and critical E2E smoke.


## Multi-player + sync confirmation

Current behavior is documented in [`docs/MULTI_PLAYER_SYNC.md`](./MULTI_PLAYER_SYNC.md), including player-id scoping, realtime subscription boundaries, and server-authoritative queue progression.


## Robustness confirmation status

See [`docs/ROBUSTNESS_ASSESSMENT.md`](./ROBUSTNESS_ASSESSMENT.md) for a candid status of what is validated vs what remains before claiming full best-practice conformance.

## Success criteria

- New contributors can run system in <30 min from README + one operations doc.
- Production incident triage starts from one canonical runbook.
- Migration policy is explicit and auditable.
- No loss of production knowledge from prior fixes.
