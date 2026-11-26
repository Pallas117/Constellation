# Sign-in recovery (break glass)

What to do when someone can't sign in, a device is lost, or the sign-in database is damaged.

- **Threat model:** TM-20. **FMEA:** FM-29.
- **The break glass** is a shell on the machine that runs the backend. Everything below needs one, so keep that machine's own login safe: FileVault, a strong account password, and Remote Login keys-only.
- **Secrets stay out of this file.** Where the sealed copy of the recovery details is kept, and who holds it, is written down privately, not here.

## Every day (automatic)

- `scripts/ops/auth-backup.sh backup` takes a consistent copy of `.auth.db` while the backend runs. It checks the copy (`integrity_check` and the sign-in tables), keeps the newest 14 copies, and writes a counts-only line to `manifest.jsonl` (no emails).
  - **Where copies go:** `~/Library/Application Support/Gauss/backups/auth` on a Mac, or `~/.local/state/gauss/backups/auth` on Linux. The folder is 0700 and each file is 0600.
- `scripts/ops/auth-backup.sh verify` is the restore test. It opens the newest copy in a temporary folder and runs the same checks. It warns when:
  - no admin account exists;
  - an admin or operator has fewer than two passkeys;
  - the newest copy is over 36 h old.
- **Off-device copies are a person's decision.** The copies hold emails and password hashes. If you move one off this machine, encrypt it first (for example `age -p`), and never put it in the repo, chat or email.

## Someone forgot their password or lost their only device

1. If they have a second passkey or SSO, they sign in with that. Password sign-in pauses after 5 failures for that email, up to 15 min; passkey and SSO don't pause.
2. If not, an admin, or anyone with the break glass, sets a new role or account:
   - `npm run auth:set-role -- <email> <user|staff|operator|admin>` changes a role;
   - a fresh sign-up with the same email is not possible while the old account exists: delete it only with the owner's confirmation.
3. Once they're in again, they **add a second passkey on a different device** straight away. The restore test warns about every admin or operator who has fewer than two.

## A device was lost or stolen

1. Revoke that device's sessions and passkeys from another signed-in device once the passkey settings from GAU-235 ship. Until then, use the break glass: `npm run auth:set-role -- <email> user` takes operator and admin powers away at once (a stolen session keeps only the viewer role), and the role goes back once the person has signed in again on a device they trust.
2. Remove its Tailscale node (admin console) and expire its key.
3. If it held an Argo device token, revoke the device on `/mesh` (staff or admin) and enrol it again with a new token.
4. Check the CyberTiger log for sign-ins from that device after the loss.

## Every admin is locked out

On the backend machine (the break glass):

```sh
npm run auth:set-role -- <your email> admin
```

Then sign in and repair the other accounts. If the account itself is gone, restore the database (next section).

## The sign-in database is lost or damaged

```sh
scripts/ops/gauss-services.sh uninstall            # stops both services (install brings them back)
scripts/ops/auth-backup.sh verify                  # pick a copy that passes
scripts/ops/auth-backup.sh restore "<backup dir>/auth-<time>.db"
scripts/ops/gauss-services.sh install              # start again
```

- `restore` refuses a copy that fails the checks.
- It never deletes the current file: that file moves aside as `.auth.db.before-restore-<time>`.
- Afterwards, check `/health`, sign in, and expect anyone who signed up after that copy to need their account again.
- Sessions in the copy are as old as the copy, and they expire on their own (12 h unused).

## After any recovery

- Note what happened and when in the ops log (`scripts/ops/gauss-services.sh events`).
- Run `scripts/ops/auth-backup.sh backup` once things are right, so the next copy is a good one.
