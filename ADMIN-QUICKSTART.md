# Admin quickstart — no deployment needed

## Temporary administrator

```
Username:  admin
Password:  ReviFlow-Temp-2026
```

Open **`Admin/admin-login.html`**. On first use you'll be asked to set your own
password (10 characters minimum) and then shown a QR code for two-step. Scan it
with Google Authenticator, Authy or 1Password and enter the six digits.

You can press **Skip for now** on the two-step screen if you'd rather set it up
later.

The temporary password stops working the moment you change it.

## Creating logins

**Admin console → New login** (top right) → **Create login**.

The first field asks **Create login for: Provider or Employee**, which then
filters the role list:

| Type | Roles |
|---|---|
| Provider | Provider (individual), Supervisor / Practice Manager |
| Employee | Employee (billing / coding), Scheduler / Front office, Administrator |

Fill in the name — the username generates itself — pick a role, and save. You get
a one-time password to hand over. The account appears in the Logins table
immediately.

## Testing a provider login

1. Create a login with type **Provider**, role **Provider**
2. Copy the generated password from the confirmation panel
3. Open **`Provider/provider-login.html`**
4. Sign in — you'll be asked to set a password and offered two-step
5. You land on the provider workspace

Supervisors see the facility-wide dropdown on the dashboard; individual
providers are locked to their own data.

## Where the data actually lives

Right now: **IndexedDB in your browser**. Passwords are hashed with PBKDF2-SHA256
at 150,000 rounds and a unique salt per account — the same algorithm class a
server would use. Nothing is stored readable.

What this means in practice:

- Accounts persist across page loads and browser restarts
- They are **per browser** — accounts made in Chrome won't appear in Firefox
- Clearing site data wipes them

That's the honest trade for running without a server. A real database needs
credentials, and credentials in a static page are readable by anyone.

## Moving to the real database

Everything already talks to one interface. In **`_store.js`**, line 10:

```js
const DRIVER = 'local';    // change to 'api'
```

Change it to `'api'` and every page starts using the Netlify Functions and
Postgres backend instead — same screens, same behaviour, no other edits. Follow
`BACKEND-SETUP.md` for the database and environment variables.

## Starting over

If you want a clean slate, open the browser console on any admin page:

```js
await RFStore.reset()
```

That wipes all accounts and restores `admin` / `ReviFlow-Temp-2026`.
