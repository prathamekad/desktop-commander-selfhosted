# SETU Release and Version Strategy

SETU uses product versions independently from the inherited upstream package version.

## Versioning
- Product releases use SemVer tags: `setu-vMAJOR.MINOR.PATCH`.
- The closed Home v1 checkpoint remains `setu-home-v1-2026-10-02`.
- Do not retag or move published release/checkpoint tags.
- MSI work begins from the protected `main` baseline after Home v1 merges.

## Change policy
- PATCH: fixes/hardening with no intended interface break.
- MINOR: backward-compatible SETU capability or installer addition.
- MAJOR: intentional compatibility, protocol, or deployment break.

## Release gates
A release candidate must come from `main`, have all required CI green, and
have no unresolved review conversations. Security-impacting dependency changes
must pass dependency review.

## Release mechanics
Until MSI onboarding is complete, releases are GitHub source/checkpoint releases
only. Do not use the inherited upstream npm/MCP Registry publishing workflow for
SETU product releases.

## Rollback
Rollback by reverting the merge on `main` or redeploying the last immutable
`setu-v*` / checkpoint tag. Never rewrite release history.
