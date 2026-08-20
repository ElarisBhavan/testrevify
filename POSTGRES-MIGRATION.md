# Revify RCM — Shared PostgreSQL deployment

This build is configured to use PostgreSQL by default. Browser IndexedDB is no
longer the default data store.

## Architecture

Browser → Netlify Functions → PostgreSQL

The authentication cookie is server-side and each browser/device gets its own
revocable session row. Multiple devices can sign in with the same account.

Clinical/application records use the existing flexible UI shapes in the
`app_records` PostgreSQL table. This is intentional for this migration: it lets
the existing HTML/JS application move to a single server data source without
rewriting every screen.

## 1. Create PostgreSQL

Use a managed PostgreSQL provider that is appropriate for your compliance
requirements. Create a database and run the complete `schema.sql` file.

The schema now includes:

- accounts
- sessions
- password history/reset
- audit logs
- organizations
- providers
- patients
- appointments
- encounters
- claims
- tasks
- eligibility
- `app_records` shared application store
- `phi_access_log`
- indexes needed by the API

Do not put a real PHI dataset into the system until your hosting/database
contracts, access controls, backups, encryption, logging and required BAAs have
been reviewed.

## 2. Netlify environment variables

Set these in Netlify:

- `DATABASE_URL`
- `JWT_SECRET`
- `BOOTSTRAP_SECRET`
- `SITE_URL`
- `REQUIRE_MFA=true`
- `REQUIRE_ADMIN_MFA=true`
- `STEDI_API_KEY` if eligibility is enabled
- `RESEND_API_KEY` and `MAIL_FROM` if password reset email is enabled

Never commit these values to GitHub.

## 3. First administrator

Deploy the site, then call `/api/bootstrap` once using the `BOOTSTRAP_SECRET`.
Use the existing BACKEND-SETUP.md instructions.

After the first administrator is created, remove `BOOTSTRAP_SECRET` from the
Netlify environment and redeploy.

## 4. Shared login

The same username/password can now be used from multiple computers.

Each sign-in creates a separate server session:

Computer A → session A
Computer B → session B

Both sessions read and write the same PostgreSQL records.

Logging out one device only revokes that device's session unless the user uses
the "sign out everywhere" action.

## 5. Excel/CSV import

Open:

`/Admin/import.html`

or use the **Data Import** tile in the admin dashboard.

The import flow:

Excel/CSV → browser parsing → normalized JSON → `/api/import` → PostgreSQL

The import endpoint is restricted to administrator/supervisor accounts and
accepts up to 10,000 rows per import.

Common column names are normalized automatically, for example:

- First Name → `first_name`
- Last Name → `last_name`
- DOB → `dob`
- Member ID → `member_id`
- Claim Number → `claim_no`
- Date of Service → `dos`
- Insurance → `payer`
- Amount Paid → `amount`

Rows with a stable identifier such as `claim_no`, `internal_id`, `member_id`,
`external_id`, or `source_key` are updated when imported again instead of
creating a duplicate. If no stable identifier exists, the importer uses a
deterministic fallback key based on the source file and row.

For large production migrations, use a dedicated staging/import process rather
than repeatedly uploading very large spreadsheets through a browser.

## 6. Important migration behavior

This build does not automatically copy old IndexedDB records from one browser
into PostgreSQL. That would be unsafe to do silently.

If the current browser contains records that must be retained, export them or
provide the source Excel/CSV files and map them through the Import Center.

## 7. Local development

The application now defaults to API/PostgreSQL mode.

If you deliberately need the old browser-only development mode, set this before
`_store.js` loads:

```html
<script>window.RF_DRIVER = 'local';</script>
```

Do not use local mode for production.

## 8. What was fixed in this build

- PostgreSQL is now the default data driver.
- Fixed the broken `L.session()` calls to use the server's `requireSession()`.
- Added the missing `app_records` table and indexes.
- Added the missing `phi_access_log` table.
- Added API storage for appointments.
- Added API storage for tasks.
- Added API storage for payments.
- Added API storage for history.
- Added API storage for credentialing.
- Added server-side task visibility enforcement.
- Added Excel/CSV import endpoint.
- Added Admin Data Import Center.
- Added import/update keys to prevent common spreadsheet duplicates.
- Added the Data Import tile to the Admin dashboard.
- Kept the existing frontend record shapes so the application does not need a
  complete frontend rewrite.

## 9. Verify before real use

Test with two different browsers/computers:

1. Computer A signs in.
2. Create a test patient.
3. Create an appointment for that patient.
4. Add an encounter.
5. Add a claim/payment as applicable.
6. Computer B signs in using the same account.
7. Confirm the patient, appointment, encounter and other records appear.
8. Edit the patient on Computer B.
9. Refresh Computer A and confirm the updated data is returned from PostgreSQL.
10. Test sign out and sign out everywhere.
11. Test an Excel import with duplicate rows.
12. Check PostgreSQL directly to confirm records are being persisted.

Do not treat a successful frontend response as proof of production readiness.
Check the database and server logs too.
