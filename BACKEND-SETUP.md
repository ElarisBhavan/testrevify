# ReviFlow — real authentication setup

Logins are stored in Postgres, passwords are hashed with scrypt, sessions are
signed JWTs in an httpOnly cookie, and two-step uses TOTP (Google Authenticator,
Authy, 1Password — any of them).

```
Browser  →  /api/auth          →  Netlify Function  →  Postgres
            /api/admin/users
```

Nothing sensitive runs in the browser. The database URL, JWT secret and API keys
live only in Netlify's environment.

---

## 1. Create a database

Any Postgres works — Neon, Supabase, Railway, RDS. Neon is the easiest fit for
serverless because it pools connections for you.

Create the database, then run **`schema.sql`** against it (Neon and Supabase both
have a SQL editor in the dashboard — paste the file and run).

Copy the connection string. It looks like:

```
postgresql://user:password@host/dbname?sslmode=require
```

> Prefer MySQL? The functions use the `postgres` driver and Postgres syntax.
> Switching means changing the driver in `netlify/functions/_lib.js` and
> adjusting `BIGSERIAL` / `TIMESTAMPTZ` / `JSONB` in the schema. Postgres is the
> shorter path.

## 2. Set environment variables

Netlify → **Site configuration → Environment variables**:

| Variable | Value | Required |
|---|---|---|
| `DATABASE_URL` | your Postgres connection string | yes |
| `JWT_SECRET` | 40+ random characters | yes |
| `BOOTSTRAP_SECRET` | any random string — used once, then deleted | first run only |
| `SITE_URL` | `https://yoursite.netlify.app` | for reset links |
| `RESEND_API_KEY` | from resend.com | for reset emails |
| `MAIL_FROM` | `ReviFlow <noreply@yourdomain.com>` | with Resend |
| `REQUIRE_ADMIN_MFA` | `true` | recommended |
| `STEDI_API_KEY` | your Stedi key | eligibility |
| `DEV_SHOW_RESET_LINK` | `true` — **development only** | optional |

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then **Deploys → Trigger deploy → Clear cache and deploy site**.

## 3. Create the first administrator

There is no sign-up screen — by design. Run this once:

```bash
curl -X POST https://yoursite.netlify.app/api/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "secret":"<your BOOTSTRAP_SECRET>",
    "username":"admin",
    "password":"a-long-passphrase-you-choose",
    "email":"you@yourdomain.com",
    "full_name":"Your Name"
  }'
```

The response contains a TOTP secret and an `otpauth://` URI. Add it to your
authenticator app now.

**Then delete `BOOTSTRAP_SECRET` from Netlify and redeploy.** The endpoint also
refuses to run once an admin exists, but removing the secret closes it properly.

### Prefer to insert the row by hand?

```sql
-- generate the hash first:
--   node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');
--            console.log(s+':'+c.scryptSync('YOUR_PASSWORD',s,64).toString('hex'))"
INSERT INTO accounts (username,password_hash,role,full_name,title,initials,scope)
VALUES ('admin','<paste the hash>','admin','System Administrator','Platform Admin','SA','all');
```

The format is `salt:hash`, scrypt, 64-byte key length.

## 4. Sign in

`https://yoursite.netlify.app/Admin/admin-login.html`

First sign-in walks you through two-step setup if `REQUIRE_ADMIN_MFA=true`.

## 5. Create everyone else

**Admin console → Logins → Create login.** Fill in name, username, role, scope,
and optionally require two-step. On save you get a one-time password to hand
over. That account can sign in at `/Provider/provider-login.html` immediately.

Roles and what they unlock:

| Role | Scope | Sees |
|---|---|---|
| `admin` | all | admin console only |
| `supervisor` | facility | every provider + facility rollup |
| `provider` | self | own data, locked to their `provider_id` |
| `scheduler` | facility | full schedule edit rights |
| `employee` | facility | employee workspace |

## Password reset

Click **Forgot password?** on either sign-in screen. The account's email gets a
link valid for 30 minutes, single use. Without `RESEND_API_KEY` no email sends —
set `DEV_SHOW_RESET_LINK=true` while testing and the link comes back in the
response instead. **Never leave that on in production**; it hands anyone a reset
link for any username.

Admins can also issue a temporary password directly from the Logins table.

## Two-step verification

TOTP is implemented in `_lib.js` from `node:crypto` — no third-party service, no
per-message cost, works offline, and the secret never leaves your database.

A one-window drift tolerance either side means a slightly wrong device clock
still works. Five failed passwords locks an account for 15 minutes.

**SMS instead?** It needs a provider such as Twilio, costs per message, and is
weaker than TOTP because of SIM-swap attacks. TOTP is the better default.

## What is deliberately not built

- **Rate limiting per IP.** Account lockout is in; a WAF rule or Netlify rate
  limiting should sit in front of `/api/auth` before real traffic.
- **Session revocation.** JWTs stay valid until they expire (8 hours). If you
  need instant revocation, add a `sessions` table and check it on each request.
- **Email verification** on new accounts.
- **Audit export.** Events are recorded in `login_events` and `account_audit`;
  reading them out is a query away.

## Security notes

- `JWT_SECRET` and `DATABASE_URL` must never appear in any committed file.
- Cookies are `HttpOnly`, `Secure`, `SameSite=Lax` — JavaScript cannot read the
  session token, which blocks the usual XSS token theft.
- Passwords are hashed per-account with a unique salt and compared in constant
  time.
- Account enumeration is blocked on the reset flow: the same message returns
  whether or not the account exists.
- This system will hold PHI-adjacent access records. Get the deployment reviewed
  against your HIPAA obligations, and make sure a BAA is in place with your
  database host, Netlify, and any email provider.
