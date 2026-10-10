# Devbox setup for coding agents

When asked to obtain and initialize this repository on a new machine:

1. Clone this repository into a dedicated task checkout.
2. Ensure Node.js 24+, npm and Git are available.
3. Run `npm run setup`.
4. If setup reports that a configured product repository is absent and the
   user requested a complete devbox environment, rerun
   `npm run setup -- --allow-clone`.
5. Never commit `pilot.local.json` or another `*.local.json` file.

`npm run setup` installs this repository's locked dependencies, initializes all
configured skill-backed product repositories, performs read-only skill
qualification, runs configuration diagnostics, executes the complete offline
check and runs the synthetic demo. It must not authenticate accounts, install
product-repository dependencies, enable write permissions or create a PR.

Use `npm run setup:repos -- --repo <id>` only when intentionally rerunning the
repository layer without reinstalling dependencies or repeating all checks.
