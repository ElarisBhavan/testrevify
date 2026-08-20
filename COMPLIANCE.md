# Hosting, HIPAA and PCI — what you actually need

## Your question: do I need to buy cloud storage?

**Yes.** Two people cannot share a login unless something they can both reach is
holding it. Right now accounts live in IndexedDB inside your browser, so they
exist only on your machine. No amount of front-end work changes that.

You need three things, and only the first is strictly about storage:

| What | Why | Rough cost |
|---|---|---|
| A Postgres database | holds accounts, patients, claims | $0–25/mo to start |
| Somewhere to run the API | Netlify Functions, already written | included with hosting |
| Email delivery | password resets | $0–20/mo |

**For a working demo shared with colleagues**, free tiers are fine. Neon,
Supabase and Railway all offer them. Total cost: nothing.

**For real patient data, free tiers are not an option** — see below.

---

## HIPAA: the honest version

**I cannot make this application HIPAA compliant, and neither can any code.**
Compliance is an organisational state, not a software feature. Roughly 60% of
it is paperwork and process that no developer can write for you.

What the code can do is implement the **Technical Safeguards** in §164.312. I
have done that, and the list is below. What you must do sits after it.

### What is now implemented

| Safeguard | Where |
|---|---|
| Unique user identification §164.312(a)(2)(i) | one account per person, no shared logins |
| Automatic logoff §164.312(a)(2)(iii) | 30 min idle, 12 h absolute, server-enforced |
| Access control §164.312(a)(1) | role checks on every endpoint, not just the UI |
| Audit controls §164.312(b) | `audit_log`, append-only, every PHI access recorded |
| Integrity §164.312(c)(1) | encounters lock; claims keep an immutable history |
| Authentication §164.312(d) | scrypt hashing, mandatory TOTP, throttling |
| Transmission security §164.312(e)(1) | HTTPS enforced, HSTS preload, strict CSP |

Sessions are held server-side, so signing out genuinely ends them — including
on a device you no longer have. Password changes revoke every other session.

### What you must do — none of it optional

1. **Sign a BAA with every vendor that touches PHI.** Your database host, your
   application host, your email provider, and Stedi. **Without a signed BAA you
   are not compliant, regardless of how good the code is.**

2. **Pick vendors that will sign one.** This is where free tiers fail:

   | Vendor | BAA available? |
   |---|---|
   | Neon | paid plans only |
   | Supabase | Team plan and above |
   | AWS RDS / Aurora | yes, under the AWS BAA |
   | Google Cloud SQL | yes, under the Google BAA |
   | Netlify | Enterprise only |
   | AWS Amplify / Lambda | yes, under the AWS BAA |
   | Resend / SendGrid | check current terms; many exclude PHI entirely |

   Terms change — confirm directly with each vendor before you commit, and get
   the BAA in writing before any real patient data is loaded.

   **Netlify is the awkward one.** A BAA needs Enterprise. If that is out of
   budget, moving the functions to AWS Lambda behind the AWS BAA is usually the
   cheaper path, and the function code ports with minimal changes.

3. **Turn on encryption at rest.** Managed Postgres usually offers this as a
   checkbox or a flag at creation. Verify it is on. §164.312(a)(2)(iv).

4. **Do the paperwork.** A security risk analysis §164.308(a)(1)(ii)(A), written
   policies, workforce training with records, a sanction policy, a breach
   notification procedure, and a designated Security Officer.

5. **Set a retention policy.** `rf_retention()` in `schema.sql` clears
   eligibility responses after 90 days and keeps audit rows six years. Schedule
   it daily and adjust to your own policy.

6. **Get an independent assessment** before go-live. I have no way to verify
   your deployment, your vendors, or your processes.

### Still outstanding in the code

- **Field-level encryption** for the most sensitive columns. Volume encryption
  covers a stolen disk; it does not protect against a compromised application
  account. Consider `pgcrypto` on names, DOB and member IDs.
- **Automatic backups with tested restores.** Enable them at the database, and
  actually practise a restore.
- **Log aggregation and alerting.** The audit table records events; nobody is
  watching it. §164.308(a)(1)(ii)(D) expects regular review.

---

## PCI DSS: the short answer is don't

**Do not store card numbers. Anywhere. Ever.**

There is currently no card handling in this application, which is the right
starting point. The moment you store a PAN you inherit all twelve PCI DSS
requirements, quarterly scans, and an annual assessment.

**Use a tokenising processor instead.** Stripe, Square, Adyen and similar
handle the card in an iframe or hosted field that your page never reads. You
receive a token; the card data never enters your systems.

Done that way you fall under **SAQ A**, the shortest self-assessment — roughly
twenty questions instead of several hundred.

### The rules if you add payments

- Never log, store or transmit a full PAN, CVV, or magnetic stripe data. CVV
  may not be stored **even encrypted**, even briefly.
- Never build your own card form. Use the processor's hosted fields so the data
  bypasses your page entirely.
- Keep payments on a separate origin from PHI where practical.
- Record only the token, last four digits, brand and expiry — which is all the
  billing screens here need.

**Where this touches your build:** the Collect button on the schedule and the
patient payment fields in Billing. Wire those to a processor's tokenised flow,
and store only the token. I have deliberately left them unimplemented rather
than build something that would put you in scope.

---

## Recommended setup for real patients

```
Database   AWS RDS Postgres, encryption at rest, automated backups   ~$30/mo
API        AWS Lambda + API Gateway, under the AWS BAA               ~$5/mo
Static     S3 + CloudFront, under the AWS BAA                        ~$5/mo
Email      a provider that signs a BAA, or send no PHI by email      varies
Payments   Stripe with hosted fields, SAQ A scope                    per transaction
```

One vendor, one BAA, encryption throughout, around $40/month before traffic.

**For a demo with colleagues today:** Neon free tier plus Netlify free tier,
`DRIVER = 'api'`, and no real patient data. That gets shared logins working
this afternoon at no cost — just don't put a real patient in it.
