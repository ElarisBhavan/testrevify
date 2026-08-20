/* ═══════════════════════════════════════════════════════════════════════
   RevifyRCM — the one setting you change by hand.

   THIS FILE IS SENT TO THE BROWSER. Anyone who opens the site can read it.
   Never put an API key, a database password or a secret here. Those live in
   the hosting environment and are listed in .env.example.
   ═══════════════════════════════════════════════════════════════════════ */

window.RF_CONFIG = {

  /* ── Where the data lives ──────────────────────────────────────────────
     'local'  Each browser keeps its own copy. Nothing leaves the machine.
              Right for building and testing.

     'api'    One shared database. Everybody sees the same patients, claims
              and logins, from any computer.

     Before switching to 'api' the hosting environment needs DATABASE_URL and
     SESSION_SECRET set, and schema.sql and schema-data.sql run against that
     database. See .env.example. */
  driver: 'local',


  /* ── Claim submission ──────────────────────────────────────────────────
     Read only. The real settings live on the server, because a Stedi key in
     a browser file would let anyone submit claims as your practice.

     These two make the interface tell the truth about what is configured;
     they do not control anything. */
  claims: {
    /* Shown on the claims screen so nobody assumes claims are going out
       when the server has no key. Leave false until STEDI_API_KEY is set. */
    configured: false,

    /* Purely a label: what the server's STEDI_USAGE is set to.
       'P' real claims reach payers · 'T' validated but not forwarded. */
    usageLabel: 'P'
  },


  /* ── Automatic submission ──────────────────────────────────────────────
     Again a label. The scheduled job reads CLAIMS_CRON_HOUR and CLAIMS_TZ
     from the server environment. */
  nightly: {
    hourLabel: '9:00 PM',
    timezoneLabel: 'America/Chicago'
  }
};

/* what _store.js reads */
window.RF_DRIVER = window.RF_CONFIG.driver;
