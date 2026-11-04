# Employer-sharing consent notice

> **Status: APPROVED — Prakash (owner), 2026-11-04.** Shipped with `CURRENT_CONSENT_VERSION =
"2026-11-04"` (`packages/types/src/index.ts`) and `kConsentVersion` in the worker app, in the
> same change. This closes E4 items 6-7 (`docs/agent/phases/E4_BUILD.md`).
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
> Woh sirf yeh dekhte hain:
>
> - Aapka kaam (jaise CNC Turner) aur anubhav
> - Aapki industry, shehar aur level
>
> Aapka **naam, phone number aur photo** nahi dikhta.
>
> Agar koi company paise dekar aapki profile **unlock** karti hai, to 14 din tak:
>
> - Woh aapka **resume** dekh sakti hai — usme aapka **phone number** hota hai (poora naam, photo
>   aur salary ki ummeed nahi).
> - Woh aapko **BadaBhai ke andar message** kar sakti hai.
>
> **Dhyaan dein:** Aap jab chaahein **Settings** me jaakar yeh band kar sakte hain. Phir companies
> aapko dhoondh ya message nahi kar paayengi. Jo resume pehle dekha ja chuka hai, woh wapas nahi
> hota.

### Prompt buttons (existing workers / Settings)

> Haan, dikhayein · Abhi nahi

## Every line is a claim about the code

| Claim                                                                                  | Where it is true                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Companies **and** placement agencies see the profile                                   | `POST /payer/candidates/search` serves company and agency payers (ADR-0022 amendment, 2026-11-03)                                                                    |
| They see role + experience, industry, city, level                                      | the masked card: `role`, `otherRoles`, `skillMonths`, `industry`, `industryMonths`, `city`, `tradeLevels` (`packages/types/fixtures/candidate-search-contract.json`) |
| No name, phone or photo before unlock                                                  | the same contract — a masked candidate carries no name, phone or photo                                                                                               |
| Unlock is paid and lasts 14 days                                                       | 1 credit; `UNLOCK_WINDOW_DAYS = 14` (`packages/db/src/credit-packs.ts`)                                                                                              |
| The résumé after unlock carries the phone, not the full name, photo or expected salary | `ResumeDisclosureService` — needs a live unlock; the employer copy prints the phone (#1594) and withholds exactly the real name, photo and expected salary           |
| Payer can message inside BadaBhai                                                      | the relay handle (ADR-0010 routed contact, E0) — gated on `employer_messaging`                                                                                       |
| Settings turns it off; then no search, no messages                                     | `withdrawEmployerContact` writes a newer row without both purposes; the search pool and the relay re-read the LATEST row                                             |
| A résumé already seen is not taken back                                                | a downloaded PDF cannot be recalled                                                                                                                                  |

If any of these behaviours change, this copy is wrong and must be re-approved.
