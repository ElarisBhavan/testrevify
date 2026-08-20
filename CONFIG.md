# Settings

Two files, and the split between them matters.

## `_config.js` — sent to the browser

Anyone who opens the site can read this file. It holds **one real setting**:

```js
driver: 'local',   // or 'api'
```

- **`local`** — each browser keeps its own copy. Nothing leaves the machine.
- **`api`** — one shared database, everybody sees the same data.

Change that word, deploy, done. The console confirms which mode is running:

```
ReviFlow build 2026.08.20-local-a · accounts: this browser only
```

The other entries in the file are **labels only** — what the claims screen says
about the hour of the nightly run, and whether a Stedi key is configured. They
display text; they control nothing.

## `.env.example` — never sent to the browser

Everything with a secret in it: the database, the Stedi key, the session
secret, the mail key. On Netlify these go in **Site configuration → Environment
variables**. Copy the file to `.env` for local function testing and do not
commit it.

## Why they are separate

A Stedi production key in a browser file would let anyone who viewed the page
source submit claims as your practice, pull eligibility for any patient, and
read your remittances. A database URL there would hand over every patient record
you hold.

There is no way to hide a value in a file the browser downloads. Obfuscating it
does not help. The only safe answer is that it never goes there — which is why
`_config.js` holds nothing worth stealing.

## Switching to the server

1. Set `DATABASE_URL` and `SESSION_SECRET` in the hosting environment
2. Run `schema.sql`, then `schema-data.sql`, against that database
3. Create the first administrator through `/api/bootstrap`
4. Change `driver` to `'api'` in `_config.js`
5. Deploy

To come back, change it to `'local'`. The browser data is still there,
untouched — the two stores are separate, so nothing is lost either way.

## For claims

`STEDI_API_KEY` must be a **production** key; test keys work for eligibility
only and the claim endpoints refuse them. `STEDI_USAGE` must match: a production
key requires `P`, and sending `T` with one is refused outright.

With `P`, claims reach real payers. To rehearse, set a claim's payer to the
**Stedi Test Payer** (`STEDITEST`) — processed and acknowledged without touching
an insurer.

## Verified

13 checks, including that no secret carries a value in the browser file, that
every setting the functions read is documented in `.env.example`, that switching
the driver actually changes what the store uses, and that all 27 pages load the
config before the store.
