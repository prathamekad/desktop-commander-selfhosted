# Contributing to SETU

SETU is maintained with a protected-main, pull-request workflow.

## Workflow
1. Start from current `main` and create a focused branch.
2. Keep runtime changes separate from repository/process changes.
3. Add or update tests for behavior changes.
4. Open a pull request using the repository template.
5. Merge only after required checks pass and conversations are resolved.

## Validation
Run `npm ci`, `npm test`, and for SETU work `npm run test:selfhost`.

## Commit discipline
Use small, descriptive commits. Prefer conventional prefixes such as
`feat:`, `fix:`, `test:`, `docs:`, `ci:`, and `chore:`.

## Security
Never commit credentials, tokens, local configuration, or private logs.
Report vulnerabilities through GitHub private vulnerability reporting, not issues.

## Upstream relationship
This repository is a SETU-focused fork of Desktop Commander. Preserve upstream
attribution and isolate upstream syncs from SETU product changes.
