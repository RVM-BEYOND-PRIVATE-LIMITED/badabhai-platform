> **NOT AN AUTHORITY. Historical snapshot. ADR-0036 (Accepted 2026-07-31) supersedes parts of
> this. Verify every claim against HEAD and against `docs/decisions/` before acting on it.**
>
> **Provenance.** Committed 2026-09-04 from `BadaBhai_MASTER_CONTEXT_2026-07-23.md.docx`, converted
> back to Markdown (headings, tables and lists preserved; Word styling dropped). It is here so an
> agent can *read* what `docs/agent/BUILD_RULES.md` used to name as source of truth #2 — not so it
> can be obeyed. It is dated 2026-07-23; the build state it reports is older still (item 3).
>
> **KNOWN-SUPERSEDED CLAIMS — the ones that have already caused wrong work:**
>
> 1. **"ADR-0035" and "ADR-0036" in §27 and §28 are NOT this repository's ADR-0035 and ADR-0036.**
>    §27 calls ADR-0035 "the hybrid deterministic-first flow" and §28 calls ADR-0036 "the LLM
>    extracts phrases; it never assigns IDs", both dated 2026-07-18. In `docs/decisions/`,
>    `0035-ai-job-posting-chat-and-cross-device-drafts.md` is the AI job-posting chat and
>    `0036-matching-algorithm-v1.md` is Matching Algorithm V1 (Accepted 2026-07-31). The numbers
>    collide and mean different things. **Cite the repository file path, never the bare number.**
> 2. **§19 "Weights & adjacency" (35/20/15/15/10/5) is retired.** ADR-0036 removes the weighted
>    engine entirely — see `docs/decisions/0036-matching-algorithm-v1.md`, which supersedes all of
>    ADR-0033 and the ranking half of ADR-0011/ADR-0015. V1 has no weights.
> 3. **PART X "BUILD STATE" is a 2026-07-18 snapshot** and roughly six weeks stale at the time of
>    committing. Every `[BUILT]` / `[PARTIAL]` / `[INERT]` tag in PARTS X and XIII must be
>    re-derived against HEAD before it is relied on.
>
> Where this document and a signed ADR disagree, **the ADR wins.** Where it and the code at HEAD
> disagree about what exists, **the code is the fact.**

---

# BadaBhai — MASTER CONTEXT

## The complete project context · 2026-07-23 · 12:08 IST

**Purpose.** This document bootstraps a brand-new chat from zero knowledge. It is deliberately exhaustive: product, strategy, every locked decision, the architecture, the build state, the open questions, the team, and the list of dead ideas that must never be resurrected. **Paste it whole. Assume no prior context. Where any older document disagrees with this one, this one wins.**

**Status tags used throughout:** `[LOCKED]` decided, do not re-open · `[BUILT]` in code · `[PARTIAL]` incomplete · `[BROKEN]` built but failing · `[MOCKED]` runs against a mock, unverified on real infra · `[OPEN]` undecided · `[PENDING]` awaiting a named action · `[DEAD]` never rebuild.

# PART I — WHAT THE COMPANY IS

## 1 · The one-page thesis

**BadaBhai turns India's blue and grey-collar industrial workers into live, profiled, contactable candidates — and sells access to that pool to anyone who pays.**

A worker opens the app and meets **"bada bhai"** — a mentor-style conversational AI that profiles them in Hinglish, by chat or voice note, and builds a **structured skill profile** plus a **free, professional résumé** they can download. Employers (companies and agencies) search a live pool of masked profiles and pay to unlock contact details.

- **Not** a job board. **Not** a staffing agency. **Not** an employer-of-record. No payroll, no compliance-for-clients, no hire guarantees.
- **Money in → reach + data + access out.** Faceless rails.
- Staffing firms are **customers, not competitors.**

**The core insight:** the worker doesn't need another listings app to scroll. They need what a good placement agent does — someone who understands their skill, presents them well, and matches them to the right employer. Delivering that personally to millions was economically impossible until conversational AI made it possible, cheaply, in the worker's own language.

**The résumé is the second front door.** ~90% of blue-collar résumés in India are copied templates with no clear work history. A free, trade-correct résumé widens the acquisition funnel **10–20×** ("I want a résumé" ≫ "I need a job this month"), raises profile-completion (the worker now has a selfish reason to finish), captures **non-job-seeking workers** (a passive pool payers value most), and feeds the training corpus. **The résumé is a profiling Trojan horse** — the same canonical data, rendered beautifully. At ~₹0.04 CAC it is acquisition spend, not leakage.

## 2 · The moat

1. **Warm institutional supply** — launches with real workers and real employers via **RVM CAD**, a 28-year industrial training institute (students, alumni, decades of employer relationships). Solves the empty-room problem that kills marketplaces.
1. **Deep domain knowledge** — understands machines, controllers, and what makes one CNC operator better than another. Generic platforms treat "CNC operator" as a job title.
1. **A proprietary dataset that compounds** — chat-built profiles workers could never type themselves, plus live intent, plus the behavioural event stream, plus an indefinitely-retained voice/transcript corpus with model-training consent from day one.
1. **A skills-taxonomy architecture** that scales across all industry without a rebuild.

**Stated honestly: AI is not the moat — AI commoditises.** The moat is what the AI accumulates and who it starts with.

## 3 · Competition & positioning

- **Vahan.ai** — the primary strategic threat (~40K placements/month, expanding into manufacturing). But Vahan outsources candidate acquisition to agencies and does payroll — "a bigger dalal." BadaBhai owns direct supply. We *do* copy Vahan's **"Mitra-Leader" referral mechanic**.
- **Naukri/Resdex** — proves the faceless data-marketplace model works at scale in India. Our edge over it: chat-built profiles (for workers who can't write résumés), live intent, and an underserved segment. The risk Naukri doesn't face: **worker over-contact** → contact caps are a retention feature.
- **Apna / WorkIndia / Job Hai** — listings-and-search products for people who can write their own résumé and apply. We do the opposite: we *build* the profile through conversation.
- **The CNC/VMC AI-placement niche is genuinely unoccupied in India — but the window is time-limited.**

# PART II — THE BUSINESS MODEL [ALL LOCKED]

## 4 · Objective and the three actors

**Objective: maximum hiring ACTIVITY (volume), never precision.** A posted job must reach the maximum relevant workers and pull maximum applications. In supply-starved trades, volume helps both sides.

**The hard constraint that shapes everything: no portal on earth can track confirmed hires.** Neither side reports them. So the system optimises **in-app behavioural proxies** — impressions, applies, payer profile-views, unlocks, contacts (call/WhatsApp), replies, response time — with **payer-side actions weighted highest** as the closest leading indicator.

| **Actor** | **Identity** | **Role** |
| --- | --- | --- |
| **Worker** | phone number | The scarce asset. Chat-profiled. **Free forever.** |
| **Payer** | **Company** account or **Agency** account | Pays for search/access and contact unlocks. **No identity verification** — a GST proves nothing and verifying it isn't our job. |
| **Agency** | separate role-aware login | **Dual-mode:** *supply* (refers workers in, earns) + *demand* (pays to pull workers out). |

There is **no structured "Employer" entity** with work-site/payroll/poster sub-roles — that was unverifiable theater and is dead.

**Important distinction:** we do **not** verify payer *identity*, but we **do** verify that a **job posting is real** (the posting verification gate). These are different things; don't conflate them.

## 5 · Supply: dual channel, one funnel

- **Channel 1 — Direct:** RVM marketing + organic downloads (turbo-charged by the free résumé).
- **Channel 2 — Agency referral:** Mitra-Leader-style referral links, payout dashboard, bulk WhatsApp invite funnels.
- **The non-negotiable rule: every worker, from every source, is profiled by the bada bhai chat.** Agencies supply *leads and reach*, never profiles. Bulk phone lists become WhatsApp invite funnels; un-profiled numbers are worthless stubs.

## 6 · Attribution & agency economics [LOCKED]

- **First-to-introduce by phone number** (phone = identity = automatic dedup).
- **90-day ownership window, no resets.**
- **25% revenue-share of every unlock** on that worker during the window.
- **₹500 minimum monthly payout**, PAN + bank required at first payout (the identity gate at the only moment it matters).
- **Payout triggers on the trackable unlock/contact event — never on the untrackable hire, and never on upload** (paying per upload breeds spam; paying on monetisation aligns agencies with quality).

## 7 · RVM CAD's boundary [LOCKED]

RVM is **go-to-market fuel and the first dataset** — marketing drives worker downloads; its placement team brings payer demand; it ratifies domain truth (trade content, skill whitelists, adjacency). **RVM is NEVER an algorithmic ranking input.** No "RVM premium," no scoring boost. The platform logic is RVM-independent. **RVM is not a permanent scope boundary.**

# PART III — MONETISATION [LOCKED]

## 8 · The six billable objects

| **Object** | **Shape** |
| --- | --- |
| `unlock_credit` | Bulk = a discount on **one purchase**; spend = **atomic, one record per worker** (caps, agency payouts, and learning signals all count per worker — a blob record would break all three). |
| `posting_fee` | Free intro → paid by **vacancy band**; band → applicant quota → **job pauses at quota** (LinkedIn-style) → top-up/boost resumes. **Quota is stamped on the job at purchase** so later tier edits never mutate live jobs. |
| `boost_fee` | Paid ranking lift, time-windowed. **Reorders within relevance; never overrides a worker's relevance floor.** |
| `credit_grant` | Every freebie source-labelled: `purchase / promo / founder_pack / referral_reward / ops_adjustment` — trackable marketing spend, not invisible leakage. |
| `agency_payout` | KYC-gated (PAN + bank at first payout). |
| `assisted_hiring_order` | **Named stub** — highest tier, RVM-style ops takeover. Schema'd, not built. |

**Payments are actor-agnostic** — any account type can pay. This decides nothing about worker-side payment; it keeps that door unbolted so the parked premium question can land either way with zero re-freeze.

## 9 · The eight CEO-locked pricing/product decisions (2026-06-19)

1. **Company job posting — free through launch, verification-gated.** Small/single-vacancy bands free forever; bigger bands free during a 15–30-day intro, then cheap. Monetise hard on **unlocks**, not posting. Revisit only once liquidity is proven. *(Land-grab + guardrail: the time-limited window vs Vahan and the data thesis both say liquidity first.)*
1. **Agency job posting — same price as a company.** Agency value is already captured twice (their 25% supply rev-share and their unlock volume). No agency-specific posting pricing.
1. **Profile unlock — ₹40 flat.** Packs of **50 / 200 / 1,000**, real discount on the 1,000-pack (steers volume to bulk → recurring). **Same price for companies and agencies.** Logic: with the 5-unlocks/worker/week cap a worker earns ≤₹200/week, so revenue comes from worker **volume** → price for adoption, not extraction. Tune within 60 days on real buying.
1. **WhatsApp — 5 nudges**, all opt-in, all pointing back into the app: invite · job alert · contact notification · come-back nudge · **"your résumé is ready — download it."** Referral nudge held until the referral mechanic is live. **The core conversation never leaves the app** (data sovereignty + insulation from Meta policy). Watch opt-out rates — they kill deliverability.
1. **North star — weekly PAID unlocks** (exclude seeded free credits so they don't flatter the number). **Hero health metric: repeat-unlock rate** (do payers come back? — the retention/NRR proof).
1. **Multi-trade visitors — welcome all + free résumé + waitlist.** Seen through the DaaS lens: every profiled worker is the data asset. **Guardrail: off-wedge handling is 100% self-serve** (zero human ops) and **waitlist messaging stays honest** (no implied imminent launch).
1. **Résumé — one excellent template per trade-family**, subtly **BadaBhai-branded and WhatsApp-share-optimised** (every forwarded résumé is free acquisition). The **edit/enrich action quietly deepens the profile**. Worker controls only safe fields (name spelling, photo on/off, phone shown/hidden, language). Multiple styles held for later, demand-driven.
1. **Reach weights — 35/20/15/15/10/5, flat**, as v1 cold-start defaults. Engineering reconciles the diverged code (ADR-0006). **No city-tuning at launch — ship flat, tune with data.No gender/age/caste/religion, ever — unambiguous yes.**

## 10 · Caps, seeding, and the standing guardrail

- **Contact caps** `[PROPOSED, partially inert]`**:** 5 unlocks per worker per 7 days (15 per 30); 50 unlocks/day/account. At cap a worker shows "currently engaged — available ."
- **Seeding:** first-10-free per new payer + RVM founder packs (generous; final numbers open).
- **Razorpay** approved (Cashfree fallback). **Real payments OFF in alpha (R17)** — accounts funded with seeded credits. GST invoice on every purchase.
- **The résumé is free forever.**
- **Workers-pay is** `[OPEN]` (premium candidate / BB-assisted floated). **The integrity guardrail stands regardless: money must NEVER tilt a worker's visibility.** Guard-enforced via the boost↔floor invariant test.

## 11 · Anti-spam & scraper defense (six layers) [LOCKED]

1. **Economic** — every contact costs credits; mass harvesting becomes a lakhs-level purchase.
1. **Rate limits** — 50/day/account + velocity & pattern anomaly detection.
1. **Identity** — OTP, device fingerprinting, duplicate phone/device detection at signup (workers, payers, agents).
1. **Behavioural** — worker-side **report button**; payers generating spam reports or zero replies get flagged; **three-strike suspension**.
1. **Data protection** — masked profiles pre-unlock; **canary (decoy) profiles** to detect scraped-data resale; **no bulk export, ever**; résumé-generation daily rate-cap.
1. **Agent reputation** — junk-referral sources auto-downweighted.

**The line is: welcome verified, paying agencies; block rogue number-harvesters.** Not "block all middlemen."

# PART IV — PRODUCT & UX [LOCKED]

## 12 · The worker experience

- **Chat-first** — the first screen is a chat window (like ChatGPT/Claude). No forms or tiles up front.
- **Role-dependent question depth** — deep for CNC; ~2–3 questions for a simple gig.
- **Hybrid profiling** — 1–2 chat prompts → a **pre-filled form pop-up** the worker confirms/edits → back to chat. *(Built but historically underused; chat-only is the most expensive possible path.)*
- **Swipe-to-apply** — right = apply, left = skip. Every swipe is a learning signal.
- **Async voice notes ≤2 min** (Sarvam STT) — transcribed, surfaced as text for confirmation, low-confidence critical fields **re-asked, not guessed**. **Never real-time voice.**
- **Phone + OTP + PIN/persistent auth** (ADR-0026). Low-literacy-first, large tap targets, high contrast.
- **Offline-tolerant** — autosave every step; a dropped session resumes, never restarts.
- **Canonical-at-capture** — every matchable field is a canonical structured value, never raw free text.
- Profile editable via a profile section **or** by telling the chat.
- Paused/quota-reached jobs vanish from feeds (never show a dead job twice).
- **The worker path works even with zero jobs present** — résumé-first and off-wedge users are first-class.

## 13 · The résumé & interview kit [BUILT]

- **Résumé:** deterministic **template-fill, no AI prose** (ADR-0013); name injected post-LLM; **WeasyPrint** PDF, cached in S3. Versioned artifact (`version`, `template_id`, `generated_at`, `source_profile_snapshot`) so better future models can re-render richer résumés from old profiles. Events: `resume.generated / downloaded / regenerated / shared`.
- **Interview kit:** (a) per-trade pre-interview **checklist**, lightly personalised; (b) per-trade **FAQ-with-answers** — **pre-built static content, authored once per trade (AI-drafted, RVM-ratified), stored in the DB, served via download — NOT per-user AI generation.** 15 trades live (TD24a). Event: `interview_kit.downloaded`. The **trade content library** is versioned, trade-keyed, **never-purge**.
- **Employer-specific interview prep (Version B) is PARKED** — it drifts toward outcome-promising liability.

## 14 · The persona [LOCKED 2026-07-13]

**Archetype:** a senior who has actually worked the floor, is on your side, and doesn't waste your time (the elder brother / the ITI instructor who cared / the helpful college senior).

**The insight:** the bot felt robotic *because it was over-warm*. "Arre waah! Zabardast!" is what bots do. **Real mentors are efficient.** Every locked attribute costs **zero or negative** tokens — the personality upgrade *is* the cost reduction.

**Six locked attributes:**

1. **Trade-fluent** — asks *"Fanuc ya Siemens?"*, not *"which control systems?"* (shorter AND instantly credible)
1. **Time-respecting** — one question per turn, under 20 words
1. **Never tests, never judges** — *"nahi pata"* is always fine
1. **Uses your name** — sparingly, at the start and close
1. **Understated acknowledgement** — max 2 words (*"Theek hai."*), **never gush**
1. **Action-oriented** — always signals what's next; closes on the résumé

**Deliberately NOT in the persona:** enthusiasm, praise, celebration, empathy speeches. *Those are exactly what make it feel like a bot.*

**Gender-neutral by construction:** the AI's *own name* is Bada Bhai (the brand), but it **addresses the worker by name + "ji"** — never "bhai." Always **"aap"**, prefer present tense, never bhai/bhaiya/beta/behen/yaar. *(Open item for the CEO: the brand name itself is gendered, and women are increasingly in QC/assembly/inspection. A conscious decision, not a default — the conversation is neutral either way.)*

## 15 · The six required questions (ask nothing else)

| **#** | **Field** | **Reach weight** |
| --- | --- | --- |
| 1 | Trade / role | 35 |
| 2 | Skills / machines *(ask only AFTER trade is known)* | 15 |
| 3 | Experience | 15 |
| 4 | **Location — current AND preferred (two distinct fields; never conflate)** | 20 |
| 5 | Salary expectation | 10 |
| 6 | Availability | 5 |

Everything else (company size, "which area," small talk) is unbilled curiosity that costs real money.

## 16 · The two client surfaces [LOCKED 2026-06-19]

1. **Worker mobile app** — Flutter (Android + iOS from one codebase; Android is the launch priority).
1. **Company/Agency web app** — Next.js. **One role-aware platform**, not two codebases. **The Agency logs in through a separate role-aware entry** because it carries the dual supply+demand flow. Agency *demand* mode = byte-for-byte the Company experience; the **supply dashboard** (referral links, earnings, KYC, payouts) is the only Agency-unique surface and is the **first fast-follow after alpha**.

# PART V — THE REACH ENGINE [architecture LOCKED]

## 17 · The five stages

**REACH** (every relevant worker sees the job — broad, never a shortlist) → **RANK** (best-first on both surfaces; ordering never hides anyone) → **PACE** (fill target = the job's **purchased applicant quota**; Wave-1 ≈ 3× vacancies; thin supply auto-widens 6–24h: area → adjacent trades → ops alert; pauses at quota) → **PROTECT** (contact caps, junk demoted, scrapers blocked, canary profiles, résumé rate-cap) → **LEARN** (classical ML on real user actions as the base grows; **tuned to widen, never narrow**).

## 18 · The pillars (non-negotiable)

- **Partial profiles work** — never drop a worker for a null field.
- **Relevance sorts, never blocks** — a so-so fit still appears, just lower.
- **Hot tag ~12%** of applicants (min absolute 70 on small pools) — "start with these," hides no one.
- **Push floor 40/100** — below it a worker still appears but isn't push-notified.
- **The LLM never ranks or rejects.** Ranking is deterministic and config-driven.
- **Boost reorders within relevance — never overrides a worker's relevance floor.**
- **No demographic inputs, ever** (gender/age/caste/religion).
- **Cold start = rules only** (works day one with zero data); ops escalation for thin supply only.
- **Every match stamped with** `engine_version` so v1 and v2 coexist and are A/B-comparable.

## 19 · Weights & adjacency

**Industrial weights (Σ100):** Trade 35 · Location 20 · Skills 15 · Experience 15 · Salary 10 · Availability 5. **Adjacency multipliers:** exact 1.00 · same family 0.90 · higher-tier→operator 0.85 · same domain, function differs 0.85 × skill-overlap · adjacent domain 0.45 · distant domain (same industry) 0.30 · operator→higher-tier 0.25 · unrelated 0.15 · different industry: no push. **Families:** {Turning} · {Milling: VMC, HMC} · {Setting/Programming: Setter-Op, CNC Programmer, CAM Programmer} · {Grinding} · {Welding/Fab} · {Moulding: injection, blow, extrusion}. **Scoring detail:** skills = coverage × embedding multiplier bounded **[0.90–1.00]** (a nudge, never a soft reject) · experience banded (meets 1.0 / one below 0.6 / two below 0.3 / fresher-OK 1.0) · location full ≤10km, convex decay to 0 at max-commute (default 25km), relocation floor 0.6 · salary asymmetric (≤max 1.0; 25% over 0.5; 50%+ over 0) · availability banded by job urgency. **Tie-breakers in order:** freshness/activity → profile completeness → most recent update.

⚠️ **ADR-0006 logged a "locked-weights divergence"** — the implemented weights may not equal the CEO-locked set. **Engineering reconciles the code to 35/20/15/15/10/5.**

# PART VI — THE TAXONOMY [LOCKED 2026-07-09]

## 20 · The three-axis model (the conceptual foundation)

The confusion that had to be resolved: "industry" was being used at two altitudes — *what sector a company is in* vs *what a worker does with their hands*. **These are independent axes.** A CNC operator works in automotive, aerospace, or pumps — same skill, three sectors. Forcing them into one hierarchy is what tangles matching.

| **Axis** | **Role** |
| --- | --- |
| **A · Skill (the spine)** | `Skill Family → Domain → Role → Skills[]`. **The ONLY thing the matching algorithm scores on.** |
| **B · Skill level / collar tier** | elementary → semi-skilled → skilled trade → technician. A real matching input; also how you decide what's "too low" for the platform. |
| **C · Sector (a TAG, not a layer)** | automotive, aerospace, pharma, textile… Captured for filtering/display. **NEVER influences matching.** |

**Identity consequence:** BadaBhai is **not "an industrial-sector app" — it is a skilled-trades app.** The fence is a *skill* fence. This means we never have to answer "which sectors count as manufacturing" — the skill spine answers it automatically. RVM teaches a **skill cluster** (metalworking/machining/CAD-CAM/tool-and-die), not a sector.

## 21 · The coordinate

`Industry → Domain → Role → Skills[]` **+** `function` **modifier + duration.**

**Five design rules:**

1. **Every work experience is its own tagged record.** A worker = the sum of their tags. A job posting = one tag.
1. **Industry/Domain/Role are single values** (the address); **Skills is a bounded list** (the detail).
1. **Anchor Industry/Domain to the TRADE, not the job's function.** A CNC person who *teaches* stays Manufacturing — "trainer" is a **function modifier**, not an industry jump. *(This is exactly how NCO-2015 codes instructors — by prefix on the occupation being instructed.)*
1. **Four levels, no deeper.** Depth is where matching complexity explodes.
1. **Skills are a closed canonical whitelist per role** — never free text.

    function ∈ { operator (default), setter, programmer, trainer, supervisor, maintenance, inspector, manager, apprentice }

**Worked example — one worker, two experiences:**

- CNC operator, 2 years → `Manufacturing → Machining & Cutting → CNC Operator · function: operator · [CNC turning, axis setting, tool-offset setting]`
- CNC software trainer, 1 year → `Manufacturing → Machining & Cutting → CNC Programmer · function: trainer · [CNC programming, CAM software, teaching]`

Filing the second under "Education industry" would scatter one person across two industries and force matching to leap across the tree. Anchoring both in Manufacturing keeps them one coherent CNC expert.

**A worker's fit to a job = their BEST-matching experience tag, never an average** — so a 2-year CNC operator who later moved on still ranks full-strength on CNC jobs.

**Both sides use the same coordinate and the same pipeline.** An employer typing "need CNC operator, Fanuc" goes through the identical embed→match→`skill_id` path. **Matching is only possible if worker and job speak one ID space.**

## 22 · Standards grounding

Built on **NCO-2015** (India, ISCO-aligned, 8-digit codes, prefixes for apprentice/foreman/instructor), **ISCO-08** (ILO, 4 levels, 436 unit groups), **O*NET** (task/skill/tool depth), **ESCO** (~3,000 occupations + ~14,000 skills, linked, free, 28 languages).

**The key structural finding:** the standards organise manufacturing work by *what the person does to the material* — ISCO 72 (metal/machinery **trades**: welders, toolmakers, and notably **7223 machine-tool setters and operators**, which ISCO merged *from* the old machine-operator group 8130, i.e. CNC setter-operators are skilled trades, not machine-minding) · ISCO 81 (stationary plant & machine operators: casting, heat-treat, **814 rubber/plastics**) · ISCO 82 (assemblers). **Our Domain layer adopts that same logic.**

## 23 · The manufacturing branch (the wedge, built to depth)

**11 domains, ~45 roles.** ★ = the 7 launch roles.

| **Domain** | **Roles** |
| --- | --- |
| **Machining & Cutting** | ★CNC Turner/Operator · ★VMC Operator · ★HMC Operator · ★CNC Setter-Operator · ★CNC Programmer (Fanuc/Siemens/Heidenhain) · ★CAM Programmer (Mastercam/EdgeCAM/NX) · ★CNC Grinding Operator · Conventional Machinist · EDM Operator |
| **Forming & Fabrication** | Welder · Sheet-Metal Worker · Structural-Metal Fabricator · Press/Stamping Operator · Blacksmith/Forging Operator |
| **Tooling, Die & Mould** | Tool & Die Maker · Mould Maker · Pattern Maker |
| **Casting & Foundry** | Die-Casting Operator · Moulder/Coremaker · Furnace/Melting Operator |
| **Heat Treatment & Finishing** | Heat-Treatment Operator · Plating/Coating Operator · Painter/Powder-Coat Operator · Polishing/Buffing Operator |
| **Plastics & Polymer** | Injection-Moulding Operator · Extrusion Operator · Blow-Moulding Operator · Rubber-Products Operator |
| **Assembly & Integration** | Mechanical Assembler/Fitter · Machine Fitter · Electrical Assembler |
| **Quality & Inspection** | Quality Inspector · CMM Operator |
| **Maintenance & Plant** | Maintenance Technician (Mechanical) · Maintenance Technician (Electrical) |
| **Production Support & Supervision** | Production Supervisor · Store/Material Handler · Machine Operator (General) |

## 24 · Implementation rules [LOCKED]

- **Adopt, don't author.** Import ESCO as the skeleton; prune white-collar branches to stubs; **hand-curate only the wedge**; leave everything else shallow until its phase arrives.
- **🔑 Embed the ALIASES, not the canonical labels.** Workers say *"mig ka kaam"*, *"meeg welding"*, *"वेल्डिंग"*, *"kharad pe kaam"* — not "MIG welding." If you embed only canonical labels, recall will be mediocre and you'll blame the model — **the model isn't the problem, the index is.No embedding model will ever place** `"kharad"` **(Hindi for lathe) next to** `"lathe operation"` — no shared token, no shared root, almost no Hinglish industrial vocabulary in training data. **That alias must be seeded by hand.**
- **Alias seeding is the highest-leverage work.** ~45 roles × ~15 skills × ~6 aliases ≈ **4,000 aliases** — bounded and finishable. Sources in order of value: **the RVM WhatsApp screenshot corpus** (real messages, real register — gold), your own profiling transcripts (every free-text `skills` array is an alias candidate), RVM instructors, then LLM-generated variants for humans to check.
- **Domain-scope the vector search — for precision, not speed.** *"Cutting"* means different things in metal, tailoring, and a salon. Question 1 gives you the domain; search inside it first, fall back to global.
- **Confidence floor ~0.80–0.85. Never force a match.** A wrong `skill_id` silently corrupts matching and you'll never find it. Sub-floor phrases → `unresolved_phrase` table.
- **Unresolved phrases are the growth engine.** Cluster weekly by embedding similarity → frequent clusters become new aliases (auto-promotable) or new skills (RVM reviews). **The taxonomy grows from real worker language, not a committee.**
- `skill_id` **is immutable and never reused.** Deprecate, never delete, never renumber — profiles and postings both reference these IDs.
- **Version the taxonomy; stamp the version on every profile** so historic profiles can be **re-tagged in batch** when the taxonomy improves. Same "better models retroactively improve old data" asset locked for voice.
- **Never let the LLM invent a** `skill_id`**.** It will, confidently. The LLM emits phrases; only the vector layer assigns IDs.
- **Provisional ≠ active** — discovered skills sit provisional until reviewed.

**Data model:**

skill(skill_id PK, label_en, label_hi, domain_id, source, status, version)

skill_alias(alias_id, skill_id FK, text, lang, source, embedding VECTOR(768))  -- the index lives HERE

unresolved_phrase(...)

## 25 · Off-wedge provision [LOCKED]

**Never reject anyone.** A tailor, carpenter, plumber, or driver gets: the same 4-part coordinate at **shallow, AI-generated depth** against ESCO-derived stub industries · a **great résumé built from their raw phrases** · the **waitlist** ("come back soon") · matched **only within their own trade** so relevancy stays trivial and the industrial core stays clean · **100% self-serve, zero human ops.**

**The elegant bit: a résumé needs raw phrases; only*matching*needs canonical IDs.** So the tailor's résumé reads perfectly ("silai," "fall-pico") while `skill_id` is null — and his phrases land in `unresolved_phrase`, seeding the tailoring taxonomy for the phase when you launch it. **Off-wedge workers build your next phase's taxonomy for free, while getting real value in return.**

# PART VII — THE AI / PROFILING ARCHITECTURE

## 26 · The pivot: canonicalisation leaves the LLM [LOCKED 2026-07-13]

**The problem:** the universal taxonomy (~17,000 skill IDs) **cannot go in the prompt** — ~150–200K tokens ≈ **₹1.40/call on Gemini, ₹14.50 on Haiku**, i.e. **₹8.40–₹87 per conversation** against a 30–40 paise budget. And accuracy collapses anyway when a model must find one right ID among 17,000 in-context.

**The evidence from 10 production transcripts:** the LLM extracted the *phrases* correctly in **every single conversation** (`"skills": ["mig welding","tig welding"]`) and produced `"skill_ids": []` in **every single conversation.The LLM is excellent at the easy half and useless at the hard half. So stop asking it to do the hard half.**

STAGE 1 — CONVERSE          STAGE 2 — EXTRACT          STAGE 3 — CANONICALISE

Cheap LLM asks the 6        Cheap LLM emits raw        NOT AN LLM.

questions in Hinglish.      PHRASES as JSON.           Embed phrase → vector-search

No whitelist. No echo.      No whitelist in prompt.    alias index (domain-scoped)

                                                       → skill_id + confidence.

                                                       ~0.01 paise. Deterministic. Auditable.

**This makes "we don't need a capable model" TRUE** — not because the hard part was ever easy, but because it left the LLM.

## 27 · ADR-0035 — the hybrid deterministic-first flow [ACCEPTED 2026-07-18]

1. Ask a **predefined set of 15 questions with tappable suggested answers**.
1. **Chip answers are canonical-direct — zero LLM, zero parsing.** Design the matchable fields chip-first so only genuinely open text ever reaches the model.
1. **Deterministic/rule-based parsing** of simple free text (typically 6–8 questions resolve here).
1. **+1 API call** — LLM structured-extraction on the **residue only**.
1. **+1 API call per batch** — remaining questions asked in **batches of 3**, **batched WITHIN a topic, never across the trade boundary** (resolve trade before asking skills, or you'll ask a welder about Fanuc controllers).
1. LLM returns JSON → appended to the existing structured JSON.
1. **Canonicalisation stage** (chips map directly; phrases → embeddings + alias layer with confidence floor; sub-floor → `unresolved_phrase`).
1. **Validator/controller** gates completeness, consistency, format.
1. **Evaluation to P95+** accuracy on the Hinglish gold set, wired as a promotion gate.

## 28 · ADR-0036 — the LLM extracts phrases; it never assigns IDs [ACCEPTED 2026-07-18]

The prompt forbids emitting `skill_id`/trade codes; **the validator rejects any model-emitted canonical ID.** Kills the class of bug where the model hallucinates or nulls canonical fields.

## 29 · The profiling system prompt (current, drop-in)

YOU ARE BADA BHAI — a senior who has worked the shop floor and is helping

this person build their work profile. You are on their side. You are not an

examiner and not a salesman.

═══ YOUR ONLY JOB ═══

Ask the required questions, then output a JSON object of what the worker

said — as RAW PHRASES. You do NOT assign skill IDs, trade codes, or any

canonical value. A separate system does that. You extract; you never map.

═══ HOW YOU SPEAK ═══

- Address the worker BY NAME + "ji" (e.g. "Nitin ji"), sparingly — at the

  start and the close. NEVER use bhai/bhaiya/beta/behen/yaar. Never assume

  gender. Always use "aap". Prefer present tense.

- Simple spoken Hinglish. ONE question per turn. Under 20 words.

- Acknowledge in MAX 2 words ("Theek hai." "Achha.") then move on.

  NEVER praise, celebrate, or gush. No "waah", "zabardast", "bahut acha".

- NEVER repeat, restate, or summarise what the worker just told you.

- Never explain why you are asking. Never ask anything not on the list below.

- "Nahi pata" is always an acceptable answer — never test, never judge.

═══ THE REQUIRED FIELDS (ask nothing else) ═══

1. name              — the worker's name

2. trade_role        — what work they do        [chips + free text]

3. skills_machines   — machines/skills; ASK ONLY AFTER trade is known

                       so options fit the trade  [chips + free text]

4. experience        — years / band             [chips]

5. city_current      — where they live NOW      [free text]  ← LIVES

6. city_preferred    — where they WANT to work  [free text]  ← WANTS

                       NEVER conflate 5 and 6.

7. salary_expectation — expected salary/band     [chips]

8. availability      — when they can start       [chips]

═══ FLOW ═══

- If the worker taps an option, that answer is final. Do NOT re-ask,

  paraphrase, or send it for parsing.

- Only genuinely free-text or ambiguous answers need your interpretation.

- Resolve trade_role BEFORE asking skills_machines.

- Batch remaining free-text questions WITHIN a topic — never mix trade

  and skills in the same batch.

═══ OUTPUT (strict JSON, phrases only, no prose) ═══

{

  "name": "...", "trade_role": "...", "skills_machines": ["..."],

  "experience": "...", "city_current": "...", "city_preferred": "...",

  "salary_expectation": "...", "availability": "...",

  "unclear": ["<fields with no usable answer>"]

}

RULES:

- Emit ONLY fields you actually have. Omit the rest; do not invent.

- NEVER output a skill_id, trade_id, or canonical code — phrases only.

- NEVER put a city into the wrong field.

- Cities are NOT sensitive — never redact them. A salary is NOT a phone

  number — never flag it.

- max_tokens is capped. Be terse.

**Engineering note (not for the model):** extraction and batch calls must be **stateless** — cached system prompt + the specific answers being parsed, **not the full running transcript**. Re-sending history is what made input tokens climb 485→839 within one conversation and made cost grow *quadratically* with turn count.

## 30 · Model routing & cost [LOCKED]

| **Stage** | **Model** |
| --- | --- |
| Chat turns | **Gemini 2.5 Flash-Lite (paid tier)** |
| Extraction | **Gemini 2.5 Flash-Lite** (the task is phrase-pulling, not canonicalisation) |
| Canonicalisation | **Vertex multilingual embeddings + pgvector** — not an LLM |
| Claude Haiku 4.5 | **Fallback / burst only** |

*(Haiku currently serves ~86% of turns — a deliberate workaround for Gemini free-tier rate limits, to be reversed in production. Haiku is ~10× input / ~12.7× output vs Gemini.)*

**Cost path — measured from the platform's own logs:**

| **Stage** | **Cost/profile** |
| --- | --- |
| Baseline (11 turns, echo, Haiku, whitelist-in-prompt) | **83 paise** |
| + Route chat to Gemini | ~36 p |
| + Kill the echo | ~20 p |
| + Cut 11 turns → 6 | ~10 p |
| + Embeddings canonicalisation | **~4 p** |
| + Form pop-up | ~2 p |
| **Further:** prompt caching (~10% of input cost), stateless turns, templated questions, hard `max_tokens` | **~1 paisa achievable** |

**Standing advice: get to ~4 paise, add caching + token caps, then STOP optimising cost and go optimise conversion.** At 4 paise, one million profiles costs ₹40,000 while a single unlock earns ₹40 — **AI cost is ~1% of the revenue from one unlock of one worker.** Moving unlock-conversion by 0.1% earns more than the entire AI budget.

**API-first stays.** Self-hosting / "AI box" / open-source (incl. Chinese models) is **not economically rational until ~250–400K profiles/month** — revisit on a measured trigger. Any candidate model must **beat the incumbent on the Hinglish gold set before taking routing share.** Cheap-and-wrong is not cheap.

**Guardrails:** ≤₹4/profile target · **₹6 hard alert + auto-downgrade** mid-conversation · token caps per conversation · **₹13K/month Stage-1 AI cap.** *(Note: LiteLLM's spend-capping was lost when it was removed — a* ***Redis-based cumulative spend cap*** *must replace it.)*

## 31 · The 10-transcript audit (2026-07-13) — findings and status

| **Finding** | **Status** |
| --- | --- |
| **Canonical extraction failing on 8/10 profiles** (`role: null, trade: null, skill_ids: []`) — a worker with empty `skill_ids` is **invisible to the Reach Engine**: unmatched, unsurfaced, never unlocked | Addressed by #428 (persist the rich draft) + #425/TD94; **verify** |
| Cost ~83 paise/profile | Routing fix pending production flip |
| **Bot REJECTED an off-wedge painter** — violating the CEO-locked welcome-everyone decision | Must be fixed; **verify** |
| Echo/repetition on nearly every turn (restating the last answer) — inflates output AND the re-sent context | Persona rewrite |
| PII guard false positives: salary "1000000" flagged as a phone number; **cities redacted** (`[CITY_1]`) — cities are a **20-point matching input, not PII** | Must be fixed; **verify** |
| `current_city: "Delhi"` **written for a worker who said he LIVES in Bihar** and would *move to* Delhi | Fixed by #431; **verify** |
| 28 billed failed LLM attempts across 10 conversations | Open |
| Asking non-matchable questions ("big company or small?", "which area?") | Fixed by the 6-question set |

# PART VIII — DATA MODEL, SCHEMA & COMPLIANCE

## 32 · Schema [FROZEN — ADR-0014, CEO-signed 2026-06-17]

**Entities:** Worker · WorkerProfile · Payer account (company/agency + modes) · Agency account · Job/Mandate · Application · Match (carries `engine_version` + component breakdown) · **Event** (the behavioural substrate) · Rating · Attribution/lead record · Consent ledger · Résumé artifact · Trade content library.

**Key fields & events:**

- Job: `vacancy_count`, `vacancy_band`, `applicant_quota` (**stamped at purchase**), `applicants_received`, boost fields, `assisted_hiring`, status incl. `paused_quota_reached`; events `job.quota_reached / paused / resumed / boost_started / boost_ended / assisted_hiring_engaged`.
- `consent.purposes[]` **includes** `model_training` **from day one** (adding it later = re-consenting everyone).
- `voice_note.retention_policy = retain_indefinitely` + `storage_class {hot, archive, physical}`.
- Trust/abuse: `report_submitted · account_flagged · strike_issued · account_suspended · canary_profile_hit`.
- Résumé: `resume.generated / downloaded / regenerated / shared`; `interview_kit.downloaded`.
- Embeddings: `vector(768)` column + **HNSW index built**.
- Every PII table carries `retention_until` + `purpose`.

**Event-store shape:** `events(event_id, actor_id, actor_type, event_type, entity_id, payload jsonb, engine_version, created_at)` — append-only, indexed on `(entity_id, event_type, created_at)`. Emitted via the **transactional outbox pattern**.

**Verification precedent:** RC2 was verified at **197/197 schema-level checks (Zod registry selftest) + 21/21 storage-level checks against live PostgreSQL 16.** Live verification counts are part of the artifact, not supplementary.

**New tables required by the taxonomy pivot:** `skill` · `skill_alias` (embedded) · `unresolved_phrase`.

**Config tables deliberately OUT of schema:** prices, vacancy bands, caps, weights, adjacency multipliers, seeding amounts.

## 33 · Behavioural signals captured (append-only, from day one)

- **Worker:** impression · card open · **swipe-right (apply)** · **swipe-left (skip)** · apply-complete · profile create/update/enrich · **profiling drop-off point** · chat actions (messages, voice-note use, form-popup completion) · session frequency · notification opens · **response time to payer contact**.
- **Payer:** search · candidate impression · profile view · **unlock** · contact click by channel (call/WhatsApp/SMS) · reply · repost · re-engagement.
- **Agency:** referral sent · invite→install→profile-completion conversion · payout events.
- **Ops:** manual overrides, escalations.

## 34 · DPDP & compliance [posture LOCKED]

- **DPDP consent at first login = the one non-negotiable gate.** Layered, plain-language, Hindi + English: (a) AI processes your chat/voice; (b) **paying companies can see your profile and contact you** — stated bluntly; (c) vendor processing; (d) retention + deletion rights; (e) **"we don't verify who contacts you"** + report button. **Includes the model-training purpose from day one.**
- **Retention:** voice ≤2 min/note · **raw audio retained INDEFINITELY** (cold/physical archive, for future in-house model training) · transcripts + chat = account lifetime · 18-month inactive → anonymise · **a deletion request overrides everything.**
- **Deletion SOP:** in-app or chat-triggered → OTP confirm → **auto-approved (a right, not a queue)** → **48-hour notice** with one-tap cancel → **full purge ≤7 days** → anonymised stubs only → immutable audit log + confirmation SMS. **Actor-scoped:** worker = full purge; company/agency = **transactions + jobs RETAINED** (personal identifiers minimised); individual agents = minimise-not-purge. **Jobs + the content library are never-purge.**
- **Vendors:** Sarvam **written enterprise zero-retention terms** required; **Google + Anthropic DPAs (no-training, ZDR) before any real PII.**
- **Pseudonymisation is a mandatory fail-closed gateway before EVERY LLM call** — phone/name never leave the building. *(Currently heuristic/non-NER — TD3. And currently over-redacting:* ***cities are NOT PII.)*
- **Residency:** all data in-region — Supabase Mumbai + AWS ap-south-1.
- **Platform terms:** discovery/data-exchange platform, **not an employer/EOR, no job guarantee**; agency attribution terms; payer terms carry **anti-scraping/anti-resale clauses with termination**.
- **Grievance Officer must be NAMED in the T&C** (legal requirement) — `[PENDING, still unnamed]`. **Prakash = 72-hour breach-response owner.**
- Penalties reach ₹250 crore — this is not a corner to cut.

# PART IX — TECHNOLOGY

## 35 · The stack [LOCKED unless tagged]

**Monorepo:** `badabhai-platform` — pnpm + Turborepo. **Backend:** NestJS (API, Reach Engine, CRM; config-driven relevance) · **CASL-based** `PoliciesGuard` for authz · transactional outbox for events. **AI service:** Python + FastAPI, stateless. **LLM:direct Gemini 2.5 Flash-Lite + Claude Haiku 4.5 REST calls — LiteLLM REMOVED (ADR-0008)**. *Consequence: needs a Redis-based cumulative spend cap to replace LiteLLM's capping.* **Data:** PostgreSQL 16 + pgvector on **Supabase Mumbai** · **Drizzle ORM** with hand-reviewed SQL migrations · **two-client Drizzle+Supabase pattern** (RLS-respecting app client + admin client) · Redis 7 + BullMQ · S3-compatible storage. **Web:** Next.js — Company/Agency self-serve web app + ops console (role-aware; agency separate login). **Mobile:Flutter** (Android + iOS from one codebase; Android is launch priority). **Structured outputs:** Instructor + Pydantic (JSON-valid ≥99% gate). **Embeddings:Vertex AI managed,** `text-multilingual-embedding-002`**, 768-dim** — column + HNSW built; **generation not yet wired.STT:Sarvam Saaras v3** (translit/codemix), async voice notes only. **Auth:** phone + OTP (**Fast2SMS** for real sends) + **PIN via scrypt**, multi-device, token rotation (ADR-0026). *Argon2id + KMS deliberately deferred to TD55.* **PDF:** WeasyPrint (cached in S3). **Payments:** Razorpay (Cashfree fallback). **Observability:Langfuse** (LLM prompts/costs/evals, now OTEL-native v4) · **Sentry** (errors/alerts) · **OpenTelemetry** (distributed traces). **CI/CD:** GitHub Actions → AWS ap-south-1; staging on **AWS Lightsail/EC2**. **Tooling:Biome** (lint+format, replaces ESLint+Prettier) · Claude Code (CLAUDE.md discipline, Plan Mode, Subagents, PreToolUse hooks). **Explicitly avoid:** Kafka · Temporal · Pinecone/Weaviate · LangChain-as-core · video interviews · real-time conversational voice. *(Revisit Qdrant only on a measured trigger: vectors >750K or filtered p95 >100ms.)*

## 36 · Architecture principles [LOCKED]

1. **The conversation is app-owned.** WhatsApp carries alerts/invites only — never the core conversation. Preserves data sovereignty and insulates from platform policy/pricing changes.
1. **Everything is an event.** The event stream is the foundation of reporting *and* the Learn layer.
1. **Clients are offline-tolerant.** Autosave each step; resume, never restart.
1. **The AI layer is cost-tiered.** Cheap model for routine turns; capable model reserved for judgment.
1. **Offline-core-only fine-tune** (ADR-0018) — no live promotion.

# PART X — BUILD STATE (snapshot 2026-07-18, main @ 86b4f6e)

## 37 · Progress

**45 migrations (0000–0044) · 34 ADRs (0001–0034) · ~66 PRs #340→#431**

| **Area** | **%** | **Note** |
| --- | --- | --- |
| **Overall** | **~85%** | B1 closed |
| **Alpha readiness** | **~78%** | 3 gates + the OTP-safety half remain |
| **Release readiness** | **~38%** | RLS / real providers / DR still deferred |
| Backend/API | ~88% | #426–#431 profiling correctness |
| Worker App | ~75% | B1 attested; mock profile-tab remains |
| Payer Web | ~85% | FE wiring closed; account-edit open |
| AI Service | ~83% | #426–#431; MUST_ASK_TOPICS promoted |
| Infra/Staging | ~80% | staging LIVE; TD81 open |
| Docs/Process | ~92% | context-drift backlog closed |

## 38 · B1 CLOSED (2026-07-18) — and what it does NOT prove

**Proven:** staging live → `/health` 200 → real OTP SMS delivers (Fast2SMS) → worker logs in → consent → chat → profile → **résumé download**. The worker-path core works end-to-end on real infrastructure. The ≤85% evidence cap is lifted; **Phase 2 (internal RVM pilot) is UNBLOCKED.**

**NOT proven:**

1. `docs/qa/evidence/staging/` **does not exist** — no `/health` output, no events-chain export, no clean logcat, no `resume.downloaded` row captured. Cheap to close on the next run (T7).
1. **🔴 TD81 — the ai-service is ABSENT from** `docker-compose.yml`**.** Staging runs **mocked AI behind a green** `/health`. Chat and extraction worked **against the mock, not Gemini**. **Real profiling on staging is unproven, cost-per-profile is unmeasured, and the entire #426–#431 correctness series is unverified on real infra until TD81 is settled.** *The deeper lesson:* `/health` *returned 200 while a core dependency was missing. Adding ai-service to compose fixes today;* ***making the mock LOUD in*** `/health` ***fixes the class.*** *Do both.*

## 39 · Shipped since last sync (#409–#431)

| **PR** | **What** |
| --- | --- |
| #426 | P1 profiling correctness — stop shipping wrong data to résumés (ai-service) |
| #427 | Session-scoped idempotency for profile extraction (closes #420) |
| #428 | **Persist the rich** `WorkerProfileDraft` **instead of discarding it** (closes #419) — likely the root of the empty canonical fields |
| #429 | **Promote salary + availability to** `MUST_ASK_TOPICS` (closes #424) |
| #430 | Bound the #420 dedupe so it can't suppress a needed extraction |
| #431 | **Stop recording where a worker LIVES as where they want to WORK** (closes #423) |
| #425 | **TD94 — plain "CNC operator" extracts no canonical role** (register) |
| #412 | **TAX-WELD-1 — welding invisible to the gazetteer — ON HOLD pending a** `role_welder` **owner ruling** |
| #409 | TD82 — reserve feed slots for security alerts so applies can't evict them |
| #406 | ADR-0032 profile skills section + photo crop/auto-refresh |
| ADR-0034 | Worker push notifications |

⚠️ **TAX-WELD-1 is blocked on a DECISION, not code — and it leaves welders unmatchable.** Chase the `role_welder` owner ruling. **It is also the first instance of a class:** every "X invisible to gazetteer" bug will recur per-trade until the alias/embedding layer lands.

## 40 · Critical path to FULL alpha GO

| **Step** | **Status** | **Owner** |
| --- | --- | --- |
| **TD81** — add ai-service to staging compose **OR** make the mock LOUD in `/health` | **P1 OPEN** | Divyanshu / DevOps |
| **Gate 1** — payer-company click-through on staging | never run on real stack | Prakash / QA |
| **Gate 2** — agency click-through on staging | never run on real stack | Prakash / QA |
| **Gate 4 (OTP-safety half)** — wrong-code neutrality, breaker at cap=0, kill-switch, no-phone/no-code log scan | never run on real stack | Rishi / QA |
| **Gate 5** — RBAC + admin ops smoke | never run on real stack | Prakash / QA |
| Capture staging artifacts → `docs/qa/evidence/staging/` | uncaptured (attestation gap) | Rishi |
| **All 6 scripts pass with evidence** | → **FULL ALPHA GO** | QA |

**Honest read: the worker path is proven (modulo the mock), but 4 of 6 gates have never run on the real stack — and gates 1, 2 and 5 are the payer, agency and admin surfaces, i.e. the entire revenue side.**

**Phase 2 can start now** — team-restricted staging bug-bash, real OTP capped. **Land the PR-#168 PIN-throttle fast-follows before PIN on real handsets.**

## 41 · Open security items (fix before Phase 3 external traffic)

| **ID** | **Risk** | **Currently bounded by** |
| --- | --- | --- |
| **R28** | `GET /workers/:id/profile` returns a **decrypted name unauthenticated** | box not public + no real worker names yet |
| **R31** | `PUT/GET /pricing/catalog` **completely unauthenticated** | `PAYMENTS_ENABLE_REAL=false` |
| **R30** | Word-split phone bypasses the pseudonymize gateway | open by design; gates `AI_ENABLE_REAL_CALLS` |
| **TD81** | ai-service absent from staging compose — mocked AI behind green `/health` | box not yet used for real AI sessions |

⚠️ **SEQUENCING CONFLICT TO WATCH:** R28's bound is *"no real worker names yet."* **Phase 2 is unblocked and startable now.** If Phase 2 stays a team-restricted bug-bash the bound holds — **but the moment real RVM students onboard, it evaporates. R28 must close before any real student touches staging.** Same for R31 the moment payments flip.

## 42 · Other open technical debt

**TD3** heuristic (non-NER) pseudonymisation · **TD4** full client-direct RLS (deferred for alpha, D6) · **TD10** secrets manager · **TD22** PII key-rotation · **TD24a** questionnaire-driven trade content · **TD27** spend ledger must move to a **Redis shared store** (caps are per-process today) · **TD42** boost ranking (boost reorders nothing today) · **TD43** per-payer capacity enforcement (inert/shadow) · **TD55** Argon2id + KMS · **R10** raw-conversation JSON bucket · **R13** résumé name via signed URL · **R16** payer identity/auth · **R17** real payments off · **R18** raw-phone reveal/telephony out of alpha · **R19** DPDP lawful-basis + `employer_sharing` notice · **BUG-2**-class: unlock-loop runtime proof.

**New TDs from ADR-0035/0036:**

| **ID** | **Item** | **Priority** | **Owner** |
| --- | --- | --- | --- |
| **TD-EMB-1** | Wire embedding generation + `skill` / `skill_alias` / `unresolved_phrase` tables — the canonicalisation stage ADR-0035 depends on. **Until live, ADR-0035 falls back to the gazetteer and TAX-WELD-1-class bugs persist.** | P1 | Divyanshu |
| **TD-CHIP-1** | Author the 15 questions with chip options per launch trade; ensure matchable fields are chip-first so they bypass the LLM entirely | P1 | Prakash / RVM |
| **TD-EVAL-1** | Stand up the P95 extraction-accuracy eval on the Hinglish gold set; wire as a promotion gate (nothing ships below P95) | P1 | Prakash |
| **TD-STATELESS-1** | Make extraction + batch calls stateless (cached system prompt + current answers, not the full transcript) — the ~4 paise target depends on it | P2 | Divyanshu |

**Dependency to state out loud: ADR-0035's cost and accuracy claims are UNVERIFIABLE until TD81 closes (staging runs the mock) and INCOMPLETE until TD-EMB-1 lands (canonicalisation still on the gazetteer).** Build the flow now; don't report its numbers as proven until both clear.

## 43 · Governance sign-offs

✅ **Schema foundation (ADR-0014) — CEO-signed 2026-06-17.** ✅ **RVM trade-content approved for manufacturing — CEO-approved 2026-06-17.** *(Hospitality content still pending product sign-off.)* ✅ **RVM = GTM only — HONORED** (RVM is the content/GTM ratification gate, never a ranking input). ✅ **All 8 build decisions D1–D8 closed (2026-06-29):** staging = Lightsail/EC2 · real OTP approved (capped) · posting-plans guard · **Prakash owns admin PII-review** · résumé PDF required for alpha · **full RLS deferred for alpha** · scrypt (not Argon2id) · alpha deadline.

**Net scope drift, acknowledged and ADR-governed:** the entire **Phase-2 surface** (reach / unlock / jobs / monetisation / capacity / learn) was **built ahead of the original "Phase-1 only" lock** — decided-as-deferred but built early, governed by ADRs 0009–0018. **The CEO and decision chats should register that Phase 2 is largely BUILT, not pending.**

# PART XI — TEAM, PROCESS & PLAN

## 44 · The team

| **Person** | **Role** |
| --- | --- |
| **Prakash Kantumutchu** | Founding Tech Lead / TPM. Architecture, AI service, payer-web frontend, ops console, content governance, infra direction, matching-spec liaison, hiring. Owns admin PII-review (D4). **Verifies all output before Done.** |
| **Akshit Makhija** | CEO, RVM CAD. Domain-truth authority, commercial sign-off, company documents, legal. **Actively hiring a dedicated CEO for BadaBhai.** |
| **Divyanshu Pant** | Backend engineer. Owns the entire NestJS backend, all DB migrations, reach-engine and pricing packages, infrastructure. Joined Jun 9. |
| **Rishi** | Sole Android/Flutter developer, owns the worker app. Joined Jun 25. |
| `[REMOVED]` | Shubham Sharma; the senior full-stack hire; Utkarsh Bhadauriya (tasks absorbed by Prakash) |
| `[PENDING]` | HR/recruitment-background ops person (thin-supply escalations, abuse triage, deletion oversight, payer hand-holding from alpha) |

**⚠️ Standing risk #1: Prakash's concentration** across AI service, payer-web, ops console, and content governance — a single point of failure. Recommended mitigation: a dedicated frontend owner so payer-web doesn't become the binding constraint.

**Risk posture: Amber.** Code is largely there; the risk is **staging + verification throughput on a thin team**, plus Phase-2-built-but-inert masking how much enforcement/verification remains.

## 45 · Working conventions [LOCKED]

- **Single-owner-per-app rule** — each app has exactly one author; integration happens only over HTTP contracts and the event schema.
- **Plan Mode required** for schema-touching changes or anything affecting ≥3 files or security/schema code. Coding agents must be explicitly constrained to this discipline.
- **Discuss → lock → build.** Never harden a spec before the discussion locks it. Formal numbered "lead-engineer corrections" with rationale are applied before artifacts freeze.
- **Verification is a first-class deliverable** — live verification counts (e.g. 197/197 schema checks, 21/21 storage checks against live Postgres) are part of the artifact, not supplementary.
- **Full developer names always** — never codes or abbreviations.
- **"Attested done" is not done.** A PR/ADR/comment saying it's finished is not evidence; only running code, cited by file and line, counts. *(TD81 is the standing proof: a green* `/health` *hid a mocked ai-service.)*
- **Two-chat convention:** an operations/tracker chat and a critical-decisions chat, bridged by this master reference. Daily `DAY N — date / DONE / IN PROGRESS / BLOCKED / NOTES` updates.
- **Tracking:** Google Sheet `1fv_hYriKwizUOawTPWZLPDDsr2btbwoT8q1TpJnBals` as source of truth (Smartsheet as fallback); Google Calendar `tech.rvmcad@gmail.com`.

## 46 · The phase expansion plan [LOCKED]

**The spine is constant.** Each phase **switches on a new region of the skill axis** — a data-and-content exercise, never a rebuild.

| **Phase** | **Scope** |
| --- | --- |
| **1 — now** | **Metal & machine trades** — CNC/VMC/HMC, tooling & die, fabrication, welding, plastics/moulding, casting, QC, maintenance. RVM's heartland; the ~45 roles already mapped. |
| **2** | **Adjacent manufacturing** — electrical/electronics assembly, auto components, sheet-metal-heavy industries, packaging, general factory operators. Heavy skill overlap with Phase 1. |
| **3** | **Process & material industries** — textiles, plastics at scale, rubber, chemicals-adjacent process work, food processing. |
| **4** | **Specialised & regulated** — pharma, medical devices, precision/aerospace. Deliberately last: needs verified skills and clean data. |
| **5+** | **Broad industrial + elementary tiers** — including the deliberate call on how far *down* the skill ladder to go (the brick-making / elementary-occupation question). |

**Sequencing logic: expand by skill-adjacency and data-availability, not by market size.** Each phase should border the last on the skill axis (so worker/skill overlap carries you), and **each needs its own warm supply source before it switches on.**

## 47 · Timeline

**Historical:** development started Jun 1 2026 · Divyanshu joined Jun 9 · Rishi joined Jun 25 · schema frozen (ADR-0014) Jun 17 · staging live + **B1 CLOSED Jul 18**. **Now:Phase 2 (internal RVM pilot) is unblocked and can start** — team-restricted staging bug-bash, real OTP capped. **Next:** close TD81 → run gates 1/2/4/5 with captured evidence → **FULL ALPHA GO** → Phase 3 employer/payer alpha (+ close LC-1, payer-web go-live waves) → Phase 4 worker-app alpha (real workers + PIN unlock) → Phase 5 agency-demand alpha → Phase 6 production hardening (RLS, KMS/Argon2id, DR, cost doc, voice DSAR) → Phase 7 paid launch. **Prior commitments still on record:** RVM to commit **100–150 workers + 10–15 companies in writing** for the internal alpha; assets ready ~5 days prior. *(The older "Aug 15 alpha / Sep soft-launch" fixed dates are superseded by this phase sequence.)*

# PART XII — OPEN DECISIONS

## 48 · Requiring a CEO ruling

1. **🔴 Flutter in-app purchases — three questions.** Workers never pay; payers are on the **web** (Razorpay ~2%). **Apple/Google take 15–30% of any in-app purchase** — on a ₹40 unlock that's up to ₹12, on the exact metric that is the north star. **As things stand the Flutter worker app needs ZERO IAP products and nothing should be created in Play Console / App Store Connect.** CEO must rule on: (a) is there any paying surface in the Flutter app at all? (b) will companies/agencies ever get a mobile app that *sells* (the Netflix/Spotify pattern — manage on mobile, purchase on web)? (c) the parked worker-premium question.
1. **Grievance Officer NAME** — legally required in the T&C.
1. **Posting-band rupee numbers** — from the cost-benefit analysis (the ₹40 unlock is fixed).
1. **Worker-premium / BB-assisted hiring** — parked; the visibility-integrity guardrail stands regardless.
1. **The brand name "BadaBhai" is gendered** — a conscious decision, not a default (the conversation is neutral either way).
1. `role_welder` **owner ruling** — blocking TAX-WELD-1; welders are currently unmatchable.
1. **Hospitality trade-content sign-off** · launch-district names · the written alpha-cohort countersign.
1. **Agency supply-dashboard timing** — fast-follow (recommended) vs pulled into alpha (and what slips).

## 49 · Engineering/product open

Daily push cap · **Learn switch-on trigger** (the data-volume threshold) · hospitality/gig weight columns · whether the self-serve web extends the ops console or is a distinct surface sharing the backend (**recommendation: distinct app, shared backend, so customer tooling and ops tooling don't entangle**) · RBAC depth for alpha (**recommendation: Owner + Recruiter at alpha, Viewer later**) · final seeding numbers.

# PART XIII — THE LEDGER

## 50 · [LOCKED] — do not re-open

Volume-first faceless data-exchange · three actors with tiered payer accounts · two client surfaces (worker Flutter app + Company/Agency Next.js web app, agency separate role-aware login) · **skills-not-sectors identity** · dual-channel supply through the mandatory chat · first-to-introduce (90d / 25% / ₹500 / PAN+bank) · six billable objects · the **eight CEO pricing decisions** · vacancy bands → quotas → pause → top-up/boost · payments actor-agnostic · résumé = versioned free front-door (deterministic template-fill) · interview kit = checklist + static per-trade Q&A from a never-purge content library · chat-first UX (role depth, form pop-up, swipe, ≤2-min voice, OTP+PIN, offline, canonical-at-capture) · the **six-attribute gender-neutral mentor persona** · the **six-question minimum set** · Reach Engine architecture + pillars + weights 35/20/15/15/10/5 · Pace target = purchased applicant quota · behavioural-proxy optimisation · **north star = weekly PAID unlocks**, hero health metric = repeat-unlock rate · the **taxonomy coordinate + function modifier + per-experience tagging + best-tag-wins** · **embeddings-based canonicalisation (ADR-0035/0036)** · off-wedge = welcome + résumé + waitlist, **never reject** · API-first, Gemini-primary routing · consent incl. `model_training` · audio retained indefinitely · actor-scoped deletion; jobs + content library never-purge · anti-spam six layers · the stack · pseudonymisation fail-closed · DPDP gate · residency India · **RVM = GTM fuel + first dataset only, never a ranking input** · the five-phase expansion plan · the working conventions.

## 51 · [BUILT / VERIFY]

Worker profiling · reach feed + RANK core · résumé + PDF · interview kit (15 trades) · consent gate · audio retention · Sarvam STT · real OTP (Fast2SMS) · PIN/multi-device/rotation (ADR-0026) · admin PII-review · unlock + posting + boost objects (gated) · payer self-serve portal (ADR-0019) · agency dual-mode backend + portal (ADR-0022) · Vertex vector column + HNSW · event spine with RLS + full-name encryption · schema frozen (ADR-0014) · staging live.

## 52 · [INERT / PARTIAL / BROKEN]

Boost **ranking** (TD42 — reorders nothing today) · per-payer capacity **enforcement** (TD43) · PACE · PROTECT · embeddings **generation** (TD-EMB-1) · payer identity/auth (R16) · full RLS (TD4) · deletion erasure flow (unproven) · weekly-paid-unlocks dashboard · the four security items (R28/R30/R31/TD81) · **canonicalisation still on the gazetteer** (TAX-WELD-1 class) · Redis shared spend ledger (TD27) · cost still ~83 paise until the routing flip.

## 53 · [BUILD NEXT]

Close **TD81** (+ make the mock LOUD in `/health`) · run **gates 1/2/4/5** and capture evidence to `docs/qa/evidence/staging/` · fix **R28** and **R31** before real students touch staging · resolve the `role_welder` ruling → unblock TAX-WELD-1 · wire **embedding generation** + `skill`/`skill_alias`/`unresolved_phrase` · **import ESCO**, seed aliases for the **7 launch roles first** from the RVM WhatsApp corpus · strip the whitelist from prompts · ship the **new persona prompt** · restore **Gemini routing** · **prompt caching + hard token caps + stateless calls** · stand up the **P95 eval** as a promotion gate · PIN-throttle fast-follows before PIN on real handsets.

# PART XIV — THE DEAD LIST

### Never rebuild. Correct any chat still carrying these.

**Matching & model:** ✗ The deterministic 100-point precision matching score as the core mechanism ✗ The old 7 weights (Trade 30 / Skills 20 / Exp 15 / Loc 12 / Sal 10 / Avail 8 / **RVM 5**) ✗ The precision trade-gate / controller / role-adjacency / CAM matrices **as a locked spec** ✗ **RVM as any ranking signal** ("RVM premium/verified") ✗ Hire / no-show as captured feedback signals (untrackable) ✗ **"Match acceptance rate" as the north star** → **weekly PAID unlocks** ✗ A hard trade gate that blocks (contradicts sort-never-block → soft family adjacency)

**Model & monetisation:** ✗ Structured "Employer" entity with work-site / payroll-EOR / poster roles → flat Payer ✗ Surfacing payroll/work-site arrangements to workers (unverifiable = liability) ✗ **"Job posting free forever"** as the final word → free through launch, **verification-gated**, revisit once liquidity is proven ✗ **Unlock price as an open range (₹30–50)** → **FIXED at ₹40 flat** ✗ **"Workers never pay" as a permanent locked principle** → **OPEN** *(the visibility-integrity guardrail still stands)* ✗ **Worker mobile app as the only client surface** → Company/Agency **web app committed**

**Data & compliance:** ✗ **"Raw audio deleted after 30 days"** → **retained indefinitely** (in-house model training) ✗ **Cities treated as PII** → cities are a **20-point matching input** and must never be redacted ✗ Salary values flagged as phone numbers

**AI & architecture:** ✗ **LiteLLM gateway** → direct Gemini/Claude REST (ADR-0008) ✗ **BGE-M3 self-hosted on an RTX 3060** → **Vertex AI managed embeddings** ✗ **AI-generated résumé prose** → deterministic template-fill, name injected post-LLM (ADR-0013) ✗ **Prompt-stuffing the skill whitelist into the LLM** → impossible at universal scale (₹8–87/conversation); **embeddings do canonicalisation** ✗ **The LLM assigning** `skill_id`**s** → it emits phrases only; the vector layer assigns IDs. *Never let the LLM invent an ID — it will, confidently.* ✗ **Claude Haiku as the default chat model** → **Gemini Flash-Lite (paid)**; Haiku is fallback/burst only ✗ **Argon2id / KMS as the alpha auth target** → **scrypt for alpha** (deferred to TD55)

**Persona & scope:** ✗ **Calling the worker "bhai"** → **name + "ji"**, gender-neutral, always "aap" ✗ **The effusive praising persona** ("Arre waah! Zabardast! Bahut acha!") → **understated mentor**; *the gushing is exactly what makes it feel like a bot* ✗ **Rejecting off-wedge workers** → profile, résumé, store, waitlist. **Never reject.** ✗ **"Industrial metal + plastics only; textile/pharma OUT for 24 months"** → **full-scale industrial, phased. RVM is the first dataset, not the ceiling.** ✗ **Sector as a scope boundary or a matching input** → **skill is the spine; sector is an optional tag that never influences matching** ✗ **Employer-specific interview prep (Version B)** for launch → parked (outcome-promising liability) ✗ Shubham Sharma / senior-full-stack staffing assumptions → Rishi owns Flutter ✗ **"Aug-15 alpha / Sep soft-launch" as operative dates** → the phase sequence from the B1 gate

# PART XV — ARTIFACT INDEX

**This document supersedes all previous "latest context" files** (`2026-07-14`, `07-09`, `06-30`, `06-19`, `06-18`, `06-12`, `06-06`, `06-05`).

**Companion documents (still current):**

1. `BadaBhai_Universal_Taxonomy_Implementation_2026-07-13.md` — how to build the taxonomy (alias embedding, confidence floors, growth loop)
1. `BadaBhai_Persona_and_1Paisa_2026-07-13.md` — the locked persona + the cost levers to 1 paisa
1. `BadaBhai_Profiling_Architecture_CostPath_2026-07-13.md` — the embeddings pivot + the rebuilt cost path
1. `BadaBhai_Conversation_Diagnostic_2026-07-13.md` — the 10-transcript audit
1. `BadaBhai_Industrial_Taxonomy_Standards_2026-07-09.md` — the standards-grounded hierarchy table
1. `BadaBhai_CEO_Context_2026-07-09.pdf` — the CEO-candidate briefing pack (IP-safe, no financials)
1. `BadaBhai_Company_Agency_WebApp_Spec_2026-06-19.md` — the payer web app full build spec
1. `BadaBhai_CEO_Decisions_PricingProduct_2026-06-18.md` — the eight decisions (all locked)
1. `BadaBhai_Conversation_Tuning_Chat_Bootstrap_2026-07-08.md` — the conversation-quality chat bootstrap
1. `Universal_Job_Matching_Engine_Feasibility_2026-06-30.md` — the taxonomy/matching feasibility research
1. Critical Thinking logs — `BadaBhai_Critical_Thinking_YYYY-MM-DD_HHMM_IST.md` (timestamped series)

**In-repo:** `PROJECT_STATUS.md` · `ROADMAP.md` · `DECISION_LOG.md` · `WORKER_AUTH_ADR0026.md` · `PAYER_WEB_GO_LIVE_PLAN` · `OWNER_TASKS` · `docs/decisions/` (ADRs 0001–0036) · `docs/qa/evidence/staging/` *(to be created)*.

## The one honest line

**~85% built, ~78% alpha-ready. The remaining gap is verification, not code** — 4 of 6 gates have never run on the real stack, TD81 means staging still runs a mocked AI behind a green health check, and the canonicalisation layer that makes the universal taxonomy work is designed and decided but not yet wired.

*Master context compiled 2026-07-23 12:08 IST from the full decision history and the* `main @ 86b4f6e` *repository snapshot (2026-07-18).* ***Re-issue after: TD81 closes · the gates run with captured evidence · TD-EMB-1 lands · the Flutter-IAP ruling · the new CEO joins.***
