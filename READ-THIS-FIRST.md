# Read this first

## If you still see `paintInsurance is not defined`

That error can only happen when **`Patient/patient-record.html` is older than
the rest of the files**. The function exists in this package — I verified it by
executing the page.

Two things cause it:

**1. Not every file was replaced.** Copying a few files over an older folder
leaves a mixture of builds. Replace the whole folder, not selected files.

**2. The browser served a cached page.** A normal reload often reuses the old
HTML. Force a fresh copy:

| Browser | Hard reload |
|---|---|
| Chrome, Edge | Ctrl + Shift + R  ·  Cmd + Shift + R on a Mac |
| Firefox | Ctrl + Shift + R |
| Safari | Cmd + Option + E, then Cmd + R |

## How to tell which build you are running

Every page now shows a small badge in the bottom right corner:

- **`build 2026.08.15-a`** in grey — correct.
- **`stale files · …`** in red — the files do not match. Hover it for the detail,
  and check the browser console.

The console also prints the build on every page load.

## Recommended: start clean

1. Delete your existing RevifyRCM folder entirely.
2. Unzip this package fresh.
3. Open a page and hard reload once.
4. Confirm the badge reads `build 2026.08.15-a`.

Your data lives in the browser's database, not in these files, so replacing the
folder does not touch your patients, encounters or claims.

## If the chart still looks empty

Open the console. Every page load prints a line like:

```
ReviFlow chart · Camille McDonald (id 1) · 2 policies · 4 encounters · 1 claim
```

That tells you what is actually in the database. If the counts are right but
the screen is empty, the fault is in rendering and the console will name the
section. If the counts are zero, the records were never written — most likely
during the period when the database was missing stores, which this build
repairs automatically on first open.
