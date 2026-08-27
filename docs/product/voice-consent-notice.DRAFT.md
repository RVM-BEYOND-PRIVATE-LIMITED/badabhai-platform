# Voice consent notice — DRAFT for legal review

> **Status: DRAFT. NOT APPROVED. NOT WIRED INTO THE APP.**
>
> `consent_screen.dart` carries an explicit instruction not to invent DPDP notice copy in the
> client, and this document exists so that instruction is not violated: the draft lives here,
> where it can be reviewed and rewritten, rather than inline where it would read as approved
> legal text.
>
> Nothing ships from this file until legal signs off. When it does, the copy and
> `CONSENT_NOTICE_VERSION` must move in the **same** change — see the rule in
> `packages/types/src/index.ts`: bumping the version while the app shows different words records,
> on every consent row, a false claim about what the worker read.
>
> Tracked by #1269. Blocks #1270 and #1271.

## What this notice has to cover, and why

`voice_processing` is a separate consent purpose because consenting to be **profiled** is
consenting to answer questions, not to be **recorded**. Three facts about the voice form are each
something a person would expect to be asked about on its own:

1. Their answers are recorded as audio.
2. The recording leaves the platform to a third-party processor (Sarvam) they have no
   relationship with.
3. Under the 2026-08-07 owner ruling the clip is kept **indefinitely** — `retain_indefinitely`,
   no TTL, no purge job.

Two more the notice should state because a worker cannot infer them:

4. Raw audio is classified in ADR-0018 as biometric voiceprint PII and is **excluded** from the
   training corpus. Any audio/ASR training use needs its own biometric-consent decision.
5. Declining recording leaves the **typed** interview fully available. The gate deliberately sits
   on the audio chokepoint, not the interview, so declining costs the worker nothing but the mic.

## Draft copy

Written for the app's audience: aap-form, short sentences, no legal register, no English
loanwords where a common Hindi word exists. Every line below is a claim about system behaviour
that is true of the code as of this branch — if the behaviour changes, this copy is wrong.

### Heading

> Aapki awaaz record karne ki ijaazat

### Body

> Aap chaahein to sawaalon ka jawaab **bolkar** de sakte hain.
>
> Agar aap bolkar jawaab dete hain:
>
> - Aapki **awaaz record hoti hai** aur humaare paas save rehti hai.
> - Us recording ko likhne ke liye hum use **Sarvam** naam ki ek doosri company ko bhejte hain.
> - Recording **hamesha ke liye save rehti hai** — hum use apne aap nahi hataate.
> - Aapki awaaz ka istemaal kisi AI ko sikhaane ke liye **nahi** kiya jaata.
>
> Agar aap ijaazat nahi dete, tab bhi aap **poora interview type karke** de sakte hain. Kuch bhi
> kam nahi hota — sirf mic band rehta hai.
>
> Aap jab chaahein apna data hataane ke liye keh sakte hain. Tab aapki recordings bhi hata di
> jaati hain.

### Checkbox label

> Main apni awaaz record karne ki ijaazat deta/deti hoon

## Open questions for legal

1. **"Hamesha ke liye" (forever).** This is the honest rendering of `retain_indefinitely`, and
   it is a strong thing to put in front of a worker. If the product would rather not say it,
   the answer is to change the retention policy, not to soften the sentence.
2. **Naming Sarvam.** DPDP requires identifying the processor. Naming a company the worker has
   never heard of may not be meaningful disclosure on its own — does it need a one-line gloss
   ("jo awaaz ko likhaai me badalti hai")?
3. **The erasure sentence.** It is true today *only when* `VOICE_NOTES_BUCKET` is set: both DSAR
   audio-deletion legs are gated on it, and after the documented rollback (unset the var) an
   erasure records `skipped` and leaves the clips. That gap is #1271. **This line must not ship
   until that is fixed**, or the notice promises something the code does not do.
4. **Device dictation is a separate transfer and is not covered here.** The composer's dictation
   mic streams the worker's voice to Google/Apple's cloud recogniser (`speech_dictation_impl.dart`
   sets no `onDevice: true`). If that affordance survives, it needs its own disclosure — see
   #1270.
5. **Withdrawal.** Does declining *after* having consented need to delete past clips, or only
   stop new ones? The code has no per-clip deletion surface at all today.
