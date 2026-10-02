# SETU Security Policy

## Reporting
Please report suspected vulnerabilities privately using GitHub Security
Advisories for this repository:
https://github.com/prathamekad/desktop-commander-selfhosted/security/advisories/new

Do not open a public issue for undisclosed vulnerabilities.

## Scope
SETU can execute commands and access authorized files on a connected machine.
Its application-level allowlists are operational guardrails, not an OS sandbox.
Use OS-level isolation when the connected client must not reach the host.

## Supported code
Security fixes target the current protected `main` branch and the latest
published SETU release/checkpoint where a safe backport is practical.

## Secrets
Never attach tokens, credentials, private keys, raw local configuration, or
unsanitized tool-call logs to public issues or pull requests.
