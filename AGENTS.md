# Working on Astra Sales Team

Read README.md and the relevant docs before changing code. This is the public
source edition. Demo data must be entirely fictional and use reserved example
domains. Never commit credentials, customer data, exports, screenshots of real
accounts, internal notes, or runtime files. Keep .env.local and .local/ private.
No infrastructure details either: no deployment platform URLs or tokens, no
server IP addresses, no SSH key names or paths, no internal domains, and no
absolute paths from a development machine — not in error messages, comments, or
example files. Tracked files only ever carry reserved example domains
(`example.invalid`, `*.example`) as placeholders.

Use npm start for the isolated demo. Tests must not contact real providers.
Sending stays disabled by default. Preserve explicit contact permission, content
approval, pause, rate limits, idempotency and API authentication when making changes.
Keep ICP rules separate from discovery, qualification and enrichment adapters.

## Infrastructure and hosting

This repository is deliberately not operated anywhere: no host, no deployment
target, no deploy hooks, no runtime credentials. `docs/setup.md`,
`apps/dashboard/DEPLOYMENT.md` and `infra/` are generic instructions for setting
up **your own** installation; they do not describe a running instance.

Operational notes about the publisher's own environment (servers, access, state
of the private sister project) live outside the publication: locally in
`CLAUDE.md` and `wiki/`, both excluded by `.gitignore`. None of that belongs in
a tracked file.
