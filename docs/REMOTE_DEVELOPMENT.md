# Remote development

How to work on Gauss Aurora from anywhere: in GitHub Codespaces, in the dev container on your own machine, or
directly on your own Mac or Linux box. All three use the same setup (`npm run dev:setup`), the same check
(`npm run dev:doctor`) and the same git hooks. How to branch, test and get a PR merged is in
`docs/CONTRIBUTING.md`.

**This repository is public.** Branches, commits and PR text can be read by anyone. Never push secrets, `.env*`,
`.auth.db`, `data/mesh/`, customer or partner data, or internal documents.

## Pick a way to work

| | Codespaces (recommended) | Dev container on your machine | Your own machine |
| --- | --- | --- | --- |
| You need | a browser or VS Code, a GitHub account | Docker + VS Code (Dev Containers extension) | Node 22, Git, TruffleHog 3; Go for `tools/argo` |
| Setup | automatic | automatic | `npm run dev:setup` |
| Internet | GitHub's datacentre (fast, stable) | yours | yours |
| Cost | your GitHub account's free monthly Codespaces quota | none | none |

## GitHub Codespaces

1. On https://github.com/Pallas117/Constellation: **Code → Codespaces → Create codespace on main**
   (or `gh codespace create -R Pallas117/Constellation`). The first build takes a few minutes: it installs Node 22,
   Go, the GitHub CLI, TruffleHog 3 and pre-commit (`.devcontainer/`), then runs `npm run dev:setup`.
2. In the terminal: `npm run dev:doctor`. Everything should be ✓ (! lines are optional).
3. `npm run dev:all`. Open port **8080** from the Ports tab. Sign up in the app, then make your local account an
   admin: `npm run auth:set-role -- <your email> admin`. This account exists only in your codespace.

Keep in mind:

- **Ports stay Private.** Forwarded ports are private by default: "Visible only to you", signed in to GitHub
  ([forwarding ports](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)).
  Never set a port to Public, not even "for a minute": the app and API would be on the open internet. To show your work, put
  screenshots or a short recording in the PR. `npm run dev:doctor` fails if a port isn't private.
- **Who pays.** A codespace is billed to the personal account that creates it, from its monthly included usage
  (GitHub Free: 120 core hours and 15 GB-month of storage, so about 60 hours a month on the default 2-core machine).
  If your account has no payment method, GitHub blocks Codespaces use once the quota is used up.
  Source: [GitHub Codespaces billing](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces).
  Stop your codespace when you're done (it also stops after 30 idle minutes by default,
  [timeout](https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces))
  and delete it once your PR has merged.
- **Secrets.** The app runs without any API keys. If a feature needs one, add it as your own Codespaces secret
  (GitHub → Settings → Codespaces → Secrets, for this repository only), never in a file you commit. Ask Josh before
  using any shared key.
- **Pushing.** Codespaces signs you in to Git and the GitHub CLI as yourself, so `git push` and `gh pr create`
  just work.

## Dev container on your own machine

Install Docker and VS Code with the Dev Containers extension, clone the repository, and run **Dev Containers:
Reopen in Container**. You get the same container as Codespaces, with the same setup. Open the app on
http://localhost:8080.

## Your own machine

1. Install Node 22 (`nvm install 22`), Git, the GitHub CLI (`gh auth login`), TruffleHog 3 and, for `tools/argo`,
   Go 1.26 or newer.
   - macOS: `brew install trufflehog gh go`
   - Linux: TruffleHog 3 from its [releases page](https://github.com/trufflesecurity/trufflehog/releases) (check the
     download against the release's `checksums.txt`), or the version pinned in `.devcontainer/Dockerfile`.
   - `pip install trufflehog` is **not** TruffleHog 3. It's an old, different tool; `npm run dev:doctor` tells you
     if it's the one on your PATH.
2. `git clone https://github.com/Pallas117/Constellation.git && cd Constellation`
3. `npm run dev:setup`, then `npm run dev:doctor`, then `npm run dev:all` (app http://127.0.0.1:8080, API :3001).

## What `npm run dev:setup` does

It's safe to re-run, and it never overwrites settings you changed.

- Checks for Node 22 and installs dependencies from `package-lock.json` when they're missing or out of date.
- Creates `.env` from `.env.example`, private to you (mode 600), with fresh development-only keys
  for device proofs and sign-in sessions. It adds the address you open the app on to `ALLOWED_ORIGINS`;
  sign-in rejects any other origin.
- Creates the local sign-in database (`.auth.db`).
- Installs the git hooks (`npm run security:setup-hooks`). Skip them with `npm run dev:setup -- --no-hooks`.

## Security tooling

GitHub Actions are switched off for this repository, so nothing checks your work after you push. These run on your
side:

| When | What | Blocks |
| --- | --- | --- |
| every commit | TruffleHog 3 on the staged files | secrets that work, or that it couldn't check |
| every commit | detect-secrets (known false positives in `.secrets.baseline`) | high-entropy strings, password-like assignments |
| every commit | never-commit check | `.env*` (except `.env.example`), `.auth.db`, `data/mesh/` |
| every commit | ESLint, JSON/YAML, merge markers, files over 2 MB | broken or oversized files |
| every commit message | Conventional Commits | messages like `fix stuff` (use `fix(api): …`) |
| before review | `npm run security:secrets` | secrets anywhere in files git would commit |
| before review | `npm run security:audit` | known-vulnerable npm dependencies |

GitHub also scans every push for provider tokens and blocks the push (secret scanning with push protection is on
for this repository).

If a hook flags a real secret: don't commit it. If it was already pushed, deleting it isn't enough; it has to be
revoked and replaced. Tell Josh straight away. If a hook flags something that isn't a secret, add a `pragma: allowlist secret`
comment on that line (detect-secrets), or explain it in your PR. Don't skip hooks with `--no-verify`.

Also:

- Turn on two-factor authentication for your GitHub account.
- Don't put tokens in URLs, logs or commit messages, and never weaken TLS or certificate checks.
- Don't let the UI poll an API route your role can't use: CyberTiger counts 401/403 responses and blocks the IP.

## Access

- **Constellation** (this repository): write access. `main` takes pull requests only (no direct pushes, force
  pushes or deletion). Josh reviews and merges.
- **Private repositories** (for example `gauss-ops`): by invitation from Josh. Accept it at
  https://github.com/notifications or in the invitation email.
- **Linear** (workspace gausstalos, team GAU): where work is planned. Name branches with the issue's git branch
  name.
- **The always-on demo** on Josh's Mac isn't shared with the team. Develop against your own local or codespace
  copy; ask Josh if you need to see the demo.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `npm run dev:doctor` shows ✗ | do what its `fix:` line says |
| `better-sqlite3` "was compiled against a different Node.js version" | `npm rebuild better-sqlite3` (or `nvm use 22` first) |
| Codespaces: "Blocked request. This host is not allowed" | restart `npm run dev:all`; the dev server allows `*.app.github.dev` only inside a codespace |
| Sign-in fails with "Invalid origin" | `npm run dev:setup -- --env-only`, then restart the backend |
| Port 8080 or 3001 already in use | stop the other dev server (`npm run dev:tailscale:doctor:fix` frees them on a Mac) |
| The TruffleHog hook fails on every commit | install TruffleHog 3 and make sure it comes first on your PATH |
