# Employer-sharing consent notice

> **Status: APPROVED — Prakash (owner), 2026-11-19.** Shipped with `CURRENT_CONSENT_VERSION =
"2026-11-19"` (`packages/types/src/index.ts`) and `kConsentVersion` in the worker app, in the
> same change. The 2026-11-04 notice is kept in the version lists so rows given on it stay valid.
> This is the #2747 notice (ADR-0064 §3.8): first name and expected salary before paying, full
> name and phone after an unlock, and a contact open for good.
>
> The worker app renders this copy **verbatim** (`apps/worker-app/lib/features/consent/
presentation/widgets/employer_sharing_notice.dart`). A wording change belongs HERE first,
> approved again, with the version bumped in the same change: bumping the version while the
> app shows different words records, on every consent row, a false claim about what the worker
> read.

## What it covers

Two consent purposes, asked together (`CONSENT_PURPOSES`, `packages/types/src/index.ts`):

- `employer_sharing` — companies and placement agencies can **find** the worker in the payer
  Candidates search (ADR-0040 pool: the latest consent row must carry it) and **unlock** him.
- `employer_messaging` — a payer holding a live unlock can **message** him over the in-app relay
  (E0, `docs/decisions/E0_RELAY_DECISION_2026-09.md` §A).

## Where it is shown (owner rulings 2026-11-04)

1. **Onboarding** — a card on the consent screen. The screen's one "I agree" tick grants
   `profiling`, `resume_generation`, `voice_processing`, `employer_sharing`,
   `employer_messaging` (the #1270 voice precedent).
2. **Existing workers** — a one-time full-screen prompt on the next app open ("Haan, dikhayein" /
   "Abhi nahi"; the dismissal is remembered on the device). "Haan" calls
   `POST /consent/employer-contact/grant`, which derives the purposes server-side.
3. **Settings** — the employer-contact switch turns it back ON through the same prompt screen,
   and OFF through `POST /consent/employer-contact/withdraw`.

## Copy (Latin Hinglish, aap-form; **bold** = bold span)

### Heading

> Companies aapki profile dekh sakti hain

### Body

> Aapko kaam dilaane ke liye, BadaBhai aapki kaam ki profile companies aur placement agencies ko
> dikhata hai.
>
> Paise dene se pehle woh yeh dekh sakti hain:
>
> - Aapka **pehla naam**
> - Aapka kaam, anubhav, machine aur level
> - Aapki industry, shehar aur **salary ki ummeed**
> - Aap aakhri baar kab active the
>
> Aapka **poora naam, phone number aur photo** nahi dikhta.
>
> Agar koi company paise dekar aapki profile **unlock** karti hai, to woh **hamesha ke liye**:
>
> - Woh aapka **poora naam aur phone number** dekh sakti hai, aur aapka **resume**.
> - Woh aapko **BadaBhai ke andar message** kar sakti hai.
>
> Jo companies aapko pehle unlock kar chuki hain, unpar bhi yahi lagu hoga.
>
> **Dhyaan dein:** Aap jab chaahein **Settings** me jaakar yeh band kar sakte hain. Phir koi
> company aapka naam ya number nahi dekh paayegi, aur aapko dhoondh ya message nahi kar paayegi.
> Jo resume pehle dekha ja chuka hai, woh wapas nahi hota.

### Prompt buttons (existing workers / Settings)

> Haan, dikhayein · Abhi nahi

## Every line is a claim about the code

| Claim                                                                                  | Where it is true                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Companies **and** placement agencies see the profile                                   | `POST /payer/candidates/search` serves company and agency payers (ADR-0022 amendment, 2026-11-03)                                                                    |
| Before paying they see the first name, work, experience, industry, city, level, expected salary and last-active | `POST /payer/candidates/search` / the applicant feed serve those facts under `APPLICANT_FACTS_ROLLOUT` (ADR-0064 §3.2) |
| No full name, phone or photo before unlock                                             | the same contract — the mask withholds the full name, phone and photo                                                                                                |
| A paid unlock shows the full name, phone and the résumé                                 | `UnlockService` / `ResumeDisclosureService` under the #2747 contact rules (ADR-0064 §3.3)                                                                            |
| The contact stays open for good                                                        | ADR-0064 §3.4 — `expires_at = 2099-12-31T23:59:59Z`, a re-open is free                                                                                               |
| Earlier unlocks follow the same rule                                                   | the earlier-unlocks line: past grants are read through the same per-worker notice gate (§3.8)                                                                        |
| Payer can message inside BadaBhai                                                      | the relay handle (ADR-0010 routed contact, E0) — gated on `employer_messaging`                                                                                       |
| Settings turns it off; then no search, no messages                                     | `withdrawEmployerContact` writes a newer row without both purposes; the search pool and the relay re-read the LATEST row                                             |
| A résumé already seen is not taken back                                                | a downloaded PDF cannot be recalled                                                                                                                                  |

If any of these behaviours change, this copy is wrong and must be re-approved.
