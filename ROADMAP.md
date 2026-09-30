# Billing Glass: focused roadmap

## Goal
Help users understand costs without confusing provider account facts with local estimates or treating unknown prices as zero.

## This small upgrade
- Correct append/restart ledger safety, latest Harness catalog alignment and reviewed holiday pricing (completed correctness work)
- Mark individual message costs as approximate local estimates, not official invoices
- Surface the message's frozen pricing source, rate mode and per-million-token rates through keyboard-focusable, screen-reader-labelled details
- Keep missing historical provenance explicit; never infer it from the current catalog

Acceptance: a historically priced message shows its stored source/rates even after the catalog changes; an unpriced message remains “未计价”, not an apparent zero; older records remain readable with “历史价格来源未记录”. The route exposes only existing pricing snapshot data, never credentials.

## Next, only when requested
1. Make unpriced reasons more specific (unknown model, missing historical policy, unreviewed holiday calendar, unavailable usage)
2. Add a compact review/export path for message-level provenance and catalog differences
3. Extend calendar coverage after authoritative annual notices and verify pricing-policy changes before applying them

## Later / deliberately out of scope
No automatic repricing of recorded history, billing/payment actions, new balance credentials, subscription-budget engine or broad visual redesign. Official balances, provider-reported usage and local message estimates remain distinct. The current 2026 holiday coverage and unknown-year behavior are documented in README.

Publication/version selection remains separate from local preparation.
