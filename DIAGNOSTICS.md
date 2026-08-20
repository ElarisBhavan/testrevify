# What was wrong, and how it was found

## The cause of the data loss

Your records were never deleted. They were unreachable.

An earlier build of `_store.js` had a faulty database upgrade handler — the
store-creation block had been duplicated four times in a tangled order. A
browser that upgraded through that build could end up with a database stamped
at the current version but **missing some object stores**.

Because the version number already matched, the upgrade handler never ran
again, so the missing stores were never created. Every read or write against
one of them threw an error. Pages that caught nothing simply stopped:
demographics would not save, insurance would not add, encounters vanished.

## The repair

`_store.js` now checks, on every open, that all thirteen stores exist. If any
are missing it bumps the version once to force the handler, creates them, and
logs:

```
ReviFlow: repairing the local database, missing stores → patients, encounters
ReviFlow: database repaired. Your records were not touched.
```

Records in the surviving stores are untouched by this. Anything written while
a store was missing was never saved, and cannot be recovered.

## Also fixed in this pass

| Problem | Effect |
|---|---|
| Schedulers and employees had no access to anything | Every section blocked or read-only |
| Read-only mode disabled Add and Edit on pages the user could edit | Buttons dead with no explanation |
| `settings.html` used six element IDs that did not exist | The profile tab threw on load |
| `logins.html` referenced a missing hint element | Threw on every keystroke in the name field |
| `message.html` referenced a missing typing indicator | Threw when opening a thread |
| Four dead links | Tiles and footers led nowhere |

## New safety net

`_guard.js` catches any uncaught error or rejected promise and shows a banner
naming what failed, instead of the page dying quietly. Every page loads it.

The patient chart also paints each section independently, so one failure can no
longer blank the others.

## How this was verified

A mock IndexedDB was written and the store exercised directly, covering
27 assertions across the full workflow: create a patient, add insurance and
contacts, edit demographics and confirm nothing else is dropped, book an
appointment, confirm the chart and the schedule search both see it, create and
lock an encounter, raise a claim, populate master data and payers, resolve a
fee, assign a task, record a credentialing enrolment, and run the hours report.

All 27 pass. Every element reference, internal link and script include across
all 26 pages was audited and resolves.

## Known gaps, honestly stated

- There is no Employee portal. Links that pointed at one now route to the
  provider login.
- Track Hours only counts sessions from the point sign-out logging was added.
  Sessions ended by closing the browser show as still open.
- Inline eligibility needs `/api/eligibility` deployed with `STEDI_API_KEY`.
  Locally it fails with an explanation rather than inventing a result.

---

# Second pass — the paintInsurance failure

## What the error meant

`paintInsurance is not defined` was exact. During an earlier edit I replaced a
block of the patient chart's script by matching a start and end marker, and the
range I matched **swallowed the entire insurance section**. The markup survived,
so the tab rendered its shell; the code that filled it was gone.

Because `paintInsurance` was called from the boot sequence, the failure took
the surrounding work with it, which is why the chart looked empty and saving
appeared to do nothing.

Restored in full:

- `paintInsurance` — renders primary, secondary and tertiary cards
- `blankIns`, the add and save handlers, rank exclusivity
- `swapBtn` and the swap picker
- `payerTypeahead` — the payer search that fills payer ID, phone and address

## Everything else this pass found

| Page | Fault | Effect |
|---|---|---|
| `Provider/dashboard.html` | `parseDay` missing | Every date calculation threw |
| `Provider/dashboard.html` | `toISOString()` for local dates | Evening entries landed on tomorrow |
| `Provider/attendance.html` | same timezone fault | Wrong day on attendance |
| `Provider/eligibility.html` | same timezone fault | Wrong date of service |
| `Patient/patient-dashboard.html` | same timezone fault | Wrong last-seen and next-appointment |

## How the search was done

A scanner now walks every page, extracts the inline scripts, collects every
declared function and every call, and reports calls with no definition. That is
what would have caught `paintInsurance` and `parseDay` before shipping. It is
in this package's history and worth re-running after any bulk edit.

Remaining flags are all false positives: CSS function names inside style
strings (`rgba`, `translateX`, `minmax`), browser globals (`IntersectionObserver`,
`QRCode`, loaded from a CDN and guarded), and function parameters (`fmt`,
`onDone`).

Two element references remain intentionally unguarded-but-safe: `#splitHint`
in `logins.html` and `#typing` in `message.html` are both null-checked at the
call site.
