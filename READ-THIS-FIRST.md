# RevifyRCM — this package

## Running on this computer only

`_store.js` is set to **local**: every browser keeps its own copy of the data and
nothing is sent to a server. Right for building and testing.

The console says so on every page load:

```
ReviFlow build 2026.08.20-local-a · accounts: this browser only
```

## Switching to Supabase later

One word, in **`_config.js`**:

```js
driver: 'local',   // change to 'api'
```

Nothing else. See CONFIG.md, and .env.example for the server settings. The console will then read
**accounts: shared (server)**.

Before flipping it you will need `DATABASE_URL` and `SESSION_SECRET` set, and
`schema.sql` and `schema-data.sql` run against the database.

## The old sign-in pages are gone

`Admin/admin-login.html` and `Provider/provider-login.html` have been deleted.
Everyone now signs in at **`reviflow.html`**, and every sign-out returns there.

That is why logging out kept taking you back to the old screens: the pages were
still in the package, and several places still pointed at them.

**Everything those pages did now happens on `reviflow.html` without leaving it:**

- signing in
- the six-digit two-step code
- setting up two-step for the first time, QR code included
- choosing a password on a first sign-in

Previously a person signing in for the first time was sent to another page to
finish, then sent on again. That handoff is gone — the whole thing happens in
one place.

`Admin/reset-password.html` is still there. It is a separate errand, reached from
an emailed link, and does not belong inside the sign-in flow.

## Where each role lands

| Role | Lands on |
|---|---|
| admin | `Admin/admin-dashboard.html` |
| supervisor, provider, scheduler, employee | `Provider/provider-dashboard.html` |
| billing | `Provider/claims.html` |
| front office | `Provider/schedule.html` |
| patient | `Patient/patient-dashboard.html` |

Case, spaces and underscores are ignored. An unrecognised role still lands
somewhere sensible.

## Also fixed in this package

Two changes from earlier were missing from the copy you sent up, so a provider
kept appearing twice in Admin → Logins — once as an account and again as
"NO LOGIN". Both are back:

- the account's link to its provider record is now saved by the server on create
  and update, and returned when listing
- the comparison is done as text, because the link arrives as a number or a
  string depending on the driver

## Verified

22 checks on the package itself: the old pages are gone, nothing links to them,
every page parses, every internal link resolves, the driver is local, and all
three verification flows are present on the sign-in page.

Plus the behaviour suites: 34 claim payload, 27 workflow, 25 sign-in routing, 13
per-tab session, 12 provider linking, 12 code lookups, 7 cascade, 7 scheduling,
6 password.

A sign-in was also run end to end with the network deliberately unavailable, to
confirm local mode never reaches for a server.
