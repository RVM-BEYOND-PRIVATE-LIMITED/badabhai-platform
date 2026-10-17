# #2344 — résumé messages with no action, answered by the companion career reply

**Date:** 2026-10-17. **Model:** claude-haiku-4-5 (real calls, `AI_PRIMARY_PROVIDER=anthropic`,
`AI_RAW_PII_ENABLED=true`, as the box runs). **Spend:** 6 reply calls, about ₹2.3.

**What it checks.** ADR-0055 §11 sends a `resume` verdict with no action to the companion's career
reply (unchanged prompt), with the résumé facts and the rolling summary. This is a smoke check that
the reply answers such messages from the résumé, rather than refusing or guessing. It is not a scored
eval: no prompt changed, so there is no baseline to beat.

**Setup.** The worktree's ai-service on :8011, `POST /free-chat/reply`, `surface: companion`,
`category: career`, `reply_language: hinglish`, no recent turns. A synthetic worker: CNC turner in
Pune, one employment row, three skills, two languages, an ITI Turner training row, preferences
(day shift, ₹25,000 expected, serving a 30-day notice). Summary: "CNC turner, Pune, 5 saal ka
experience / Day shift chahiye, 25 hazaar tak". The messages are the device test's own line, the
three gold-set `resume`/null lines and two of their shape.

## Result: 6/6 answered, every answer drawn from the résumé facts

| Message | Answer (lines) |
|---|---|
| meri profile kis chij ki he | Aapka profile mein CNC lathe operation aur Fanuc programming likha hai. / Aapke paas ITI Turner qualification hai aur Shree Ganesh Engineering mein kaam ka experience hai. / Vernier aur micrometer use karne ka skill bhi likha hai, yeh sab acha hai. |
| mera resume | Aapka resume mein CNC lathe operation aur Fanuc programming likha hai. / Shree Ganesh Engineering mein shaft aur bush turning ka kaam dikha hai. / Vernier aur micrometer skills bhi add hain, yeh sab acha hai. / Kya aap kisi aur skill ko add karna chahte hain resume mein? |
| resume se related kaam hai | Aapka resume bilkul theek hai, CNC lathe aur Fanuc programming likha hai. / Shaft aur bush turning ka kaam aapne Shree Ganesh mein kiya, yeh bahut valuable hai. / Day shift aur 25 hazaar salary preference sab likhi hai, employers ko clear dikhai jayega. / Kya aap kisi aur skill ko add karna chahte hain, ya kuch aur change karna hai? |
| meri profile se related or kuch sikhna he | Aap CNC lathe mein achhe se kaam kar rahe hain, ab CAD aur CAM seekhna bahut kaam aayega. / Yeh skills se aap design se lathe program tak sab kar sakte hain, aur pay bhi badhega. / Ek online course ya institute se 2-3 mahine mein seekh sakte hain, kya seekhna pasand hai? |
| resume ke baare mein kuch poochna tha | Aapka resume dekh liya maine, CNC lathe aur Fanuc programming likha hai. / Kya aap kisi aur skill ko add karna chahte hain, ya kisi cheez ko badalna hai? / Resume tab mein jakar aap apna profile dekh aur edit kar sakte hain. |
| resume wali baat karni hai | Aapka resume dekh liya maine, Shree Ganesh Engineering mein CNC lathe ka kaam likha hai. / Aap Fanuc control, shaft turning aur bush turning seekh chuke hain, yeh sab kaam ka hunar hai. / Day shift aur 25 hazaar salary ke liye aapne likha hai, aur 30 din ka notice period bhi likha hai. / Resume mein aur kya badalna hai, ya kisi skill ko add karna hai? |

The model's follow-up chips are not served on this route: the résumé root menu's keyed options are
(`v3AnswerWithMenuTurn`). The API's output screen (`screenFreeChatAnswer`) still runs on every answer
in production. A rejected answer serves the bare root menu, the turn this route served before.

**Not measured here.** Repeat variance (one pass per message, temperature 0.5) and the screen's
served rate on these lines.
