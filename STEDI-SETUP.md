# Stedi setup

## The 404 you are seeing

`/api/claims` returned **404**, which comes from your own site — not Stedi.
Stedi answers `400` or `422` when it dislikes a claim, never 404 at that URL.
Nothing reached them, which matches what you saw in their portal.

Two things must both be published:

1. **`netlify/functions/claims.js`** — the function itself.
2. **The `/api/claims` redirect in `netlify.toml`:**

```toml
[[redirects]]
  from = "/api/claims"
  to   = "/.netlify/functions/claims"
  status = 200
  force = true
```

After deploying, open the Claims page. It now pings the endpoint on load and
shows a red banner if it is still missing, so you do not discover it mid-submission.

To check by hand:

```
curl -X POST https://your-site.netlify.app/api/claims \
  -H 'Content-Type: application/json' \
  --data '{"dryRun":true,"claim":{"control":"PING","lines":[],"dx":[]}}'
```

- **404** → the function or redirect is not published.
- **401/403** → deployed, but you are not signed in (expected from curl).
- **503 `not_configured`** → deployed, but `STEDI_API_KEY` is missing.
- **200 with a payload** → working.

## Environment variables

| Variable | Purpose |
|---|---|
| `STEDI_API_KEY` | Sent as the `Authorization` header. |
| `STEDI_SUBMITTER_ID` | Your submitter identification. |
| `STEDI_USAGE` | `T` for test, `P` for live. **Defaults to `T`.** |

Set these under **Site settings → Environment variables**, then redeploy.
Environment changes need a fresh deploy to take effect.

## Test versus live

`usageIndicator` defaults to `T`. Per Stedi's documentation, a test claim is
**not sent to the payer** — Stedi validates it and returns a 277CA
acknowledgment so you can exercise the whole pipeline safely. Test claims are
visible in the portal only when **Test mode is toggled ON** in the claims view.

If you were looking at the portal with test mode off, that is another reason a
claim would appear to be missing.

Set `STEDI_USAGE=P` when you are ready for real claims.

## Before real claims will pay

**Transaction enrollment.** Some payers require a provider to be registered
before they accept 837 claims through a new clearinghouse. Check the payer in
Stedi's Payer Network, and if enrollment is needed:

1. Create a provider record in the Stedi portal under Providers.
2. Submit an enrollment request for professional claims under Enrollments.

This is done in Stedi, not in this application.

## What this build sends

- `Idempotency-Key` on every request, so a retry after a network failure cannot
  double-bill. Safe to reuse for 24 hours.
- A patient control number that is **17 characters or fewer, alphanumeric and
  unpredictable**, following Stedi's guidance. Predictable numbers create
  duplicates across patients and break ERA matching.
- Amounts as strings, the rendering provider on each service line, and
  `serviceFacilityLocation` inside `claimInformation` — verified against the
  documented request shape with 30 assertions.

## SFTP

Not yet implemented. It is where **835 remittances** arrive, so it is the piece
worth adding when you want payments posted automatically:

```
sftp <username>@transfer.us.stedi.com      # port 22
put your-claim-file.x12 to-stedi/
ls from-stedi/                             # 999s, 277CAs and 835 ERAs
get from-stedi/<response-file>.x12
```
