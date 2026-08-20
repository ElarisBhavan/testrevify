# Sessions, passwords and going global

## What changed

**One session per browser, shared by every tab.** The session used to live in
`sessionStorage`, which is per-tab — signing out in one tab left the others
signed in. It now lives in `localStorage` and is coordinated by `_session.js`
through a `BroadcastChannel`, with a `storage`-event fallback for older
browsers.

Sign out anywhere and every open tab follows within milliseconds — provider
pages, admin pages, patient charts, all of them.

**Sessions now expire.**

| Rule | Value | Behaviour |
|---|---|---|
| Idle timeout | 30 min, or the value in Settings → Security | Any tab's activity resets it for all |
| Absolute ceiling | 12 hours | Applies regardless of activity |
| Role guard | per page | Admin pages reject non-admin sessions |

Whichever way a session ends, the login page explains it — *Signed out for
inactivity*, *Session expired*, or *Not permitted*.

## Passwords

Hashed with **PBKDF2-HMAC-SHA256 at 310,000 rounds**, the current OWASP
recommendation, with a 16-byte random salt per account and constant-time
comparison. Stored as:

```
pbkdf2$310000$<salt hex>$<hash hex>
```

Accounts created before this change used 150,000 rounds in a `salt:hash`
format. Those still verify, and are **silently re-hashed at the new work
factor on the account's next successful sign-in** — no reset needed.

Plaintext passwords are never stored, transmitted, or recoverable. A forgotten
password can only be replaced, not read back.

## Making logins global

Right now accounts live in IndexedDB, which is **per browser**. An account
created in Chrome will not exist in Firefox or on another machine. That is a
property of running without a server, not a bug.

Everything is already written against one interface with two drivers. In
`_store.js`, near the top:

```js
const DRIVER = 'local';    // change to 'api'
```

Set it to `'api'` and every screen switches to the Netlify Functions and
Postgres backend — same pages, same behaviour, accounts shared by everyone on
every device. The remote driver is complete: sign-in, MFA, account management,
password reset and sign-out all route to the server, which sets an **httpOnly,
Secure, SameSite=Lax** cookie that JavaScript cannot read.

Follow `BACKEND-SETUP.md` for the database, environment variables and the
one-time bootstrap of the first administrator.

### Server-side hashing

The Netlify functions use **scrypt** (N=16384, r=8, p=1, 64-byte key) with a
per-account salt, which is stronger than PBKDF2 for this purpose because it is
memory-hard. Browser and server hashes are not interchangeable, so accounts are
re-created rather than migrated when you switch — do the switch before you have
real users, or re-issue passwords from the admin console afterwards.

## Honest limits

- **Client-side idle timeout can be bypassed** by someone with devtools on
  their own machine. It protects an unattended workstation, not a determined
  local user. Server-side JWT expiry, already implemented in the backend, is
  the real control.
- **No cross-device sign-out** until you deploy. `BroadcastChannel` is
  per-browser; signing out on a laptop cannot reach a phone without a server.
- **Rate limiting** is per-account (five failures locks for fifteen minutes),
  not per-IP. Put a WAF rule or Netlify rate limiting in front of `/api/auth`
  before real traffic.
- **PHI**: eligibility responses and patient records in IndexedDB are not
  encrypted at rest. On a shared workstation, that data is readable by anyone
  with access to the browser profile. Deploying moves it server-side, which is
  what your HIPAA obligations will require.
