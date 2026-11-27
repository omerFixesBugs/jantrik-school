# Legal drafts: read this first

> **DRAFT FOR LAWYER REVIEW — NOT LEGAL ADVICE. Not for publication or signature until reviewed
> by a lawyer qualified in Bangladesh.**

Three drafts, written on 2026-11-18/19 from the product's code and docs by an assistant while the
owner was away. They describe only what the software does today and mark what is planned.

| File                                                                 | What it is                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [terms-of-service.md](terms-of-service.md)                           | The agreement between Jantrik and each institute (the business customer).                                                |
| [privacy-policy.md](privacy-policy.md)                               | The public notice: who decides what, what is held, how long, rights, cookies.                                            |
| [school-data-custody-agreement.md](school-data-custody-agreement.md) | The data processing agreement: Jantrik handles Institute Data on its behalf; security, sub-processor, retention annexes. |

The model: **the institute decides** (data fiduciary / controller-like), **Jantrik processes on
its behalf**. Most data is about children. Placeholders: `[Company legal name]`, `[address]`,
`[governing court]`, `[fee schedule]`, `[hosting provider]` and similar; `[to verify]` marks law
nobody has checked; `[to decide]` marks the owner's choices.

## Bangladeshi law: what was checked

Checked on the web on 2026-11-18 (news and secondary sources, **not the gazette texts**). Every
point below still needs the lawyer to confirm against the official text.

| Law                                                       | What the sources say                                                                                                                                                                                                                                                                                | Sources                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Personal Data Protection Ordinance, 2025                  | Gazetted in November 2025 (Ordinance No. 61 of 2025), with the National Data Governance Ordinance, 2025. Reported: "data fiduciary" / "data processor" roles; parent or guardian consent for children; no profiling or targeted ads for minors; some sections in force 18 months after the gazette. | [TBS](https://www.tbsnews.net/node/1281356), [Daily Star](https://www.thedailystar.net/tech-startup/news/bangladeshs-personal-data-protection-ordinance-2025-key-takeaways-4015401), [Digital Policy Alert](https://digitalpolicyalert.org/change/18757-personal-data-protection-amendment-ordinance-2026-ordinance-no-23-of-2026)                                       |
| Personal Data Protection (Amendment) Ordinance, 2026      | 5 February 2026 (No. 23 of 2026): narrowed data localisation to a synchronised copy in Bangladesh for some data (reports differ on which), dropped jail terms for some violations.                                                                                                                  | [Digital Policy Alert](https://digitalpolicyalert.org/event/38601-president-implemented-personal-data-protection-amendment-ordinance-2026-ordinance-no-23-of-2026)                                                                                                                                                                                                       |
| **Personal Data Protection Act, 2026**                    | Parliament passed the Personal Data Protection Bill, 2026 on 9 April 2026; the Daily Star says it became an Act on 15 April 2026. Act number (63 of 2026?), commencement, rules, the authority's name and breach-notification duties: **[to verify]** (sources conflict).                           | [UNB](https://unb.com.bd/category/Bangladesh/parliament-passes-31-bills-related-to-ig-era-ordinances/183312), [Daily Star, 7 July 2026](https://www.thedailystar.net/slow-reads/big-picture/news/why-bangladeshs-new-data-protection-law-may-fail-protect-your-data-4217396), [Securiti (vendor)](https://securiti.ai/bangladesh-personal-data-protection-act-overview/) |
| Cyber Security Act, 2023 → Cyber Security Ordinance, 2025 | The 2023 Act was repealed and replaced by the Cyber Security Ordinance, 2025 (gazetted May 2025).                                                                                                                                                                                                   | [Dhaka Tribune](https://www.dhakatribune.com/bangladesh/381943/govt-issues-gazette-of-cyber-security-ordinance)                                                                                                                                                                                                                                                          |
| Cyber security law of 2026                                | Parliament replaced the ordinance with a Cyber Security Bill/Act, 2026 (April 2026; the exact date and name **[to verify]**), amended about 30 June 2026 (BTRC and other agencies may block content and request user data from platforms); further amendments proposed.                             | [Prothom Alo](https://en.prothomalo.com/bangladesh/wbq9kji6z7), [Dhaka Tribune](https://www.dhakatribune.com/bangladesh/parliament/414016/cyber-security-amendment-bill-2026-passes-in)                                                                                                                                                                                  |
| Information and Communication Technology Act, 2006        | Act No. XXXIX of 2006, amended 2013. Which sections still apply to a SaaS provider: **[to verify]**.                                                                                                                                                                                                | [ICJ brief](https://www.icj.org/wp-content/uploads/2014/06/Bangladesh-ICT-Brief-2013.pdf)                                                                                                                                                                                                                                                                                |
| Payment and Settlement Systems Act, 2024                  | Payment services and gateways need a Bangladesh Bank licence; a draft PSO regulation (2025) lists SSLCOMMERZ among operators. SSLCommerz's current licence: **[to verify]**.                                                                                                                        | [Dhaka Tribune](https://www.dhakatribune.com/amp/business/420801/bb-warns-against-22-unauthorized-online-payment)                                                                                                                                                                                                                                                        |
| BTRC and A2P SMS                                          | BTRC licenses/enlists A2P SMS aggregators and has cancelled many (41 in January 2025, 22 in March 2026); limits on promotional SMS. The actual rules (hours, content, masking): **[to verify]**. The Bangladesh Telecommunications (Amendment) Bill, 2026 passed on 9 April 2026.                   | [Meatechwatch](https://meatechwatch.com/2026/03/03/btrc-cancels-certificates-of-22-a2p-sms-service-providers-over-noncompliance/), [UNB](https://unb.com.bd/category/Bangladesh/parliament-passes-31-bills-related-to-ig-era-ordinances/183312)                                                                                                                          |
| Consumer Rights Protection Act, 2009                      | Act No. 26 of 2009. Whether it covers a business customer of a SaaS: **[to verify]**.                                                                                                                                                                                                               | [FAOLEX](https://leap.unep.org/en/countries/bd/national-legislation/consumers-right-protection-act-2009-act-no-26-2009)                                                                                                                                                                                                                                                  |

**Not checked at all [to verify]:** the Children Act, 2013; the Contract Act, 1872; the Evidence
Act, 1872 (electronic records); the Arbitration Act, 2001; the Right to Information Act, 2009 (for
government institutes); education-board and ministry record-keeping rules; VAT on software
services; Bangladesh Bank / mobile financial service rules on collecting fees into personal bKash
or Nagad numbers; any e-commerce or digital-commerce rules.

## Open questions for the lawyer

1. **The data protection Act.** Is the Personal Data Protection Act, 2026 in force, with which
   commencement dates, rules and authority? Do the terms "data fiduciary", "data processor" and
   "data custodian" fit this model (institute decides, Jantrik processes)?
2. **Children.** What consent is needed for children's data, from whom, in what form, and must
   the software record it? Under 18 throughout? Anything special for madrasas and coaching
   centres?
3. **Localisation.** Must any of this data (or a synchronised copy) stay in Bangladesh? Is a
   server in Singapore or Mumbai allowed, and for backups?
4. **Sensitive data.** Are birth registration numbers, religion, blood group and photos
   "sensitive" or "restricted", and what follows?
5. **Breach notification.** Who must notify (institute, Jantrik, both), whom, and how fast? Is
   48 hours from Jantrik to the institute right?
6. **Retention and erasure.** SMS logs, audit logs, attendance and payments are kept with no end
   date today. Which need an end date, and which school records must institutes keep by law? Does
   the right to erasure force a permanent-delete feature before go-live?
7. **Authorities.** Which laws let which authorities demand data from Jantrik directly, and may
   Jantrik tell the institute?
8. **SMS.** What BTRC rules apply to an institute's SMS to its own guardians (absent alerts,
   reminders, broadcasts)? What must the SMS provider contract contain?
9. **Fees into personal numbers.** May an institute collect fees on a personal bKash/Nagad
   number? Should the terms warn against it?
10. **Liability.** A sensible cap, a higher cap for data breaches, and what cannot be excluded.
11. **Contract form.** Click-through in the app, a signed order form, or both; Bangla and English
    versions, and which prevails.
12. **Disputes.** Courts (which?) or arbitration in Dhaka.
13. **Guardians.** Do guardians need their own short notice on first sign-in, given they never
    sign the terms?
14. **Jantrik's own staff access.** What policy and logging is needed for engineers who can reach
    the database directly?

## Open questions for the owner

1. Company legal name, registration, address, contacts, and a data protection contact.
2. Hosting provider and region; off-site backup storage; SMS provider (must be BTRC-licensed).
3. Fee schedule, trial length, invoice due days, late-payment suspension notice.
4. Support hours and channels; whether to promise an uptime target.
5. Export window and deletion period at the end, and building the full-export and deletion tools
   before the first institute leaves.
6. Breach notice period to institutes (the drafts say 48 hours).
7. When to add end dates for SMS and audit logs.
