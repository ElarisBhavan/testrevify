# RevifyRCM

Static site + ReviFlow application. No build step — open `index.html` or deploy the
folder as-is to Netlify.

## Structure

```
index.html            Marketing home
resources.html        Resources
insights.html         Insights
reviflow_2.html       Role portal (Employee / Provider / Admin)
netlify.toml          Netlify config (publish = ".")

Provider/
  provider-login.html       Login -> provider-dashboard.html
  provider-dashboard.html   Workspace tiles
  dashboard.html            Analytics dashboard
  eligibility.html          Eligibility form (+ 24h history)
  eligibility-result.html   Full benefits breakdown
  schedule.html             Calendar grid
  tasks.html                Task queue + assign
  attendance.html           Leave and working hours
  settings.html             Preferences (writes to _prefs.js)
  _prefs.js / _prefs.css    Shared preference layer, loaded by every page

Patient/
  patient-dashboard.html    Clients and contacts list + New record wizard

Admin/     (empty - queued)
Employee/  (empty - queued)
```

## Flow

reviflow_2.html -> Provider/provider-login.html -> Provider/provider-dashboard.html
-> tiles open eligibility, schedule, tasks, attendance, settings, dashboard, patients

## Shared preferences

`Provider/_prefs.js` applies accent colour, larger text, reduced motion and row
density from localStorage on every page. Settings writes to it; changes take
effect across the whole provider login.

## Still to build

patient record detail, create claim, reports, message, admin section,
employee section, master data, schedule role-access + collect payment.
