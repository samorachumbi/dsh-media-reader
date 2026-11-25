# Security

## Reporting a vulnerability or a leaked credential

**Email samora@itikia.co.ke** with the subject line `Security` — do not open a public issue.

<mailto:samora@itikia.co.ke?subject=Security>

Please include what you did, what happened, and the version (`dsh plugin list`, or the bundle
filename). If you found a credential in a public place, tell me where it is and do not repost it.

**What to expect:** an acknowledgement within one business day, an assessment of severity and a fix
or a mitigation as fast as the severity warrants. This is a one-person product, so the honest target
is days for a genuine issue, not hours — but you will get a reply and a decision, not silence.

## Scope

In scope: the plugin's tools and its handling of local files, the licence Worker
(`dsh-licence.itikia.workers.dev`), the storefront (`store.itikia.co.ke`), and anything that could
leak a buyer's data, a licence key, or a payment detail.

Out of scope: findings that require an already-compromised machine, social engineering of the
operator, and reports produced solely by an automated scanner without a demonstrated impact.

## What this product holds

No hosted copy of your media. The plugin reads files on the machine it runs on; a text-only route
sends derived text to the configured model, which is documented in the storefront's
[privacy policy](https://store.itikia.co.ke/privacy). Licence records are keyed by an unguessable
reference and hold the licensee's name, the email it was issued to, and the artifact hash — never a
payment instrument.

## Please do not

- Post a working exploit, a key, or a customer's data in a public issue, a gist or a paste site.
- Test against another buyer's licence or order reference. There is one buyer so far; a test that
  touches their record is an incident, not a finding.
