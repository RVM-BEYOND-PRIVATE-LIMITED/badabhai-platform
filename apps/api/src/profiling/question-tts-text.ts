import { CHAT_OPENING_TEXT, CHAT_UNAVAILABLE_REPLY } from "../chat/chat-replies";
import {
  CLOSING_REPLY_TEXT,
  DE_ESCALATION_REPLY_TEXT,
  DISAMBIGUATION_PROMPT_TEXT,
  HARDSHIP_REPLY_TEXTS,
} from "./next-question";
import { normalizeReplyText } from "./reply-closure";

/**
 * THE DEVANAGARI SIDECAR (#896) — the native-script twin of every string the interview can say.
 *
 * WHY IT EXISTS. The whole corpus is romanized Hinglish declared `hi-IN`: "…resume banate hain",
 * in Latin letters, with zero Devanagari codepoints in 466 pack items. No on-device voice can
 * pronounce that. A `hi-IN` voice is built for Devanagari and mangles the Latin ("banate" →
 * "banit"); an `en-IN` voice reads it as English. Both were verified on device. For a worker who
 * cannot read the screen, a confidently mispronounced question is worse than silence, because
 * nothing on screen lets them catch it. The text has to BE Devanagari to be spoken correctly.
 *
 * WHY NOT TRANSLITERATE AT RUNTIME. Romanization is lossy: "बनाते" and "बनते" both write as
 * "banate", and no phone can recover which one was meant. The mapping has to be authored once,
 * by someone who knows which word it was, and shipped.
 *
 * KEYED BY THE ROMAN TEXT ITSELF, not by `question_key`, and that is the load-bearing choice:
 *
 *   - ONE lookup covers everything. Pack prompts, `retry_text`, the `why_text` + question clarify
 *     JOIN, and the eight constants that belong to no pack are all just reply strings by the time
 *     they reach a serializer. Keying by question_key would have needed a second map for the
 *     constants and a `servedText`-shaped decision (prompt? retry? join?) re-derived at every
 *     call site — the orchestrator builds a reply at thirteen places, and each one would have had
 *     to state its own answer.
 *   - TRANSCRIPT HYDRATION FALLS OUT. `GET /chat/sessions/:id/messages` replays `body_text` and
 *     has no question_key to hand (the durable row's `metadata` is a closed slug set that must
 *     never hold worker-authored text). Keyed this way, the stored line looks itself up.
 *   - DRIFT IS A TEST FAILURE. The keys are LITERAL roman strings, deliberately not imports of
 *     the constants below. Import the constant and an edit to the English silently re-keys the
 *     entry, leaving Devanagari that no longer says the same thing — the exact failure this file
 *     exists to prevent, now invisible. Spelled out, an edit orphans the key and
 *     `question-tts-text.test.ts` fails until the pair is re-authored together.
 *
 * This is the same content-addressed shape the voice form already uses for its pre-rendered audio
 * (`tts_clip_id: clipId(turn.reply)` in `profiling-session.service.ts`) — that surface resolves a
 * Sarvam-rendered clip by reply text, this one resolves a script for the on-device voice.
 *
 * ADDITIVE AND OPTIONAL. A miss returns `undefined`, the field is omitted, and the client speaks
 * the romanized text exactly as it does today. Nothing regresses where a pair is not yet authored.
 *
 * COVERAGE. All 439 clips of the reply closure: 8 constants, 130 prompts, 5 retries, 144
 * why-texts — and the 152 clarify clips are COMPOSED rather than authored (see
 * {@link composeClarify}), because a clarify reply is by construction `why + " " + question` and
 * hand-writing the 152 products of pairs we already hold would be 152 more chances to disagree
 * with them. `question-tts-text.test.ts` holds the table to the closure in both directions.
 *
 * ON THE TRANSLITERATION ITSELF. Devanagari punctuation with one deliberate exception: the danda
 * (।) closes a statement, but questions keep the Latin `?`, which is what Hindi text uses in
 * practice and what a TTS voice needs to see to apply question intonation. Loanwords a worker
 * actually says in Hindi are written in Devanagari (मशीन, लाइसेंस, शिफ्ट), not left in Latin —
 * a `hi-IN` voice reads Latin as English. Initialisms a Hindi speaker spells out letter by letter
 * (MIG, TIG, CCTV, AC, PVC, GI, LT, HT, QC, HMV) deliberately STAY in Latin, because that is how
 * the voice pronounces them correctly; the test allows uppercase Latin for exactly this reason
 * and forbids lowercase, which is what an untransliterated word looks like.
 */

/**
 * Roman → Devanagari, for the strings that belong to NO pack.
 *
 * Every entry is `CONSTANT_REPLIES` (`reply-closure.ts`) in the same order, and
 * `question-tts-text.test.ts` asserts that correspondence both ways: a ninth constant added to
 * the orchestrator without its Devanagari twin fails, and a key here that no longer matches any
 * constant fails.
 */
const CONSTANT_TTS_TEXT: Readonly<Record<string, string>> = {
  // chat-replies.ts — the AI service is unreachable and no turn happened.
  "Abhi thodi dikkat aa rahi hai. Ek minute baad dobara bhejiye.":
    "अभी थोड़ी दिक्कत आ रही है। एक मिनट बाद दोबारा भेजिये।",

  // chat-replies.ts — the one-shot composite opener; the FIRST thing a worker ever hears.
  "Namaste. Aap kaun sa kaam karte hain, kahan rehte hain, aur kitna tajurba hai?":
    "नमस्ते। आप कौन सा काम करते हैं, कहाँ रहते हैं, और कितना तजुर्बा है?",

  // next-question.ts — the fixed de-escalation line.
  "Aap se vinamra rehne ki request hai. Kaam ki baat karte hain.":
    "आप से विनम्र रहने की रिक्वेस्ट है। काम की बात करते हैं।",

  // next-question.ts — the closed hardship appreciation set, indexed by turn.
  "Samajh sakta hoon. Aapki baat sahi hai.": "समझ सकता हूँ। आपकी बात सही है।",
  "Aapki mehnat samajh aati hai. Thoda aur batayiye.": "आपकी मेहनत समझ आती है। थोड़ा और बताइये।",
  "Theek hai. Aaram se batayiye, koi jaldi nahi.": "ठीक है। आराम से बताइये, कोई जल्दी नहीं।",

  // next-question.ts — served when the interview ends normally.
  "Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.":
    "आपकी बात पूरी हो चुकी है। प्रोफ़ाइल तैयार हो रही है।",

  // next-question.ts — asked ABOUT the packs, so it lives in none of them.
  "Aap in mein se kaun sa kaam karte hain?": "आप इन में से कौन सा काम करते हैं?",
};

/**
 * Roman → Devanagari for the QUESTION a worker is asked: `prompt_text` and `retry_text`.
 *
 * Both live in one table because `servedText` picks between them and the resulting string is all
 * a serializer ever sees — and because {@link composeClarify} has to be able to find either as
 * the tail of a clarify join, which is exactly what the engine's own `joinClarify` produces.
 *
 * ONE ENTRY PER DISTINCT STRING, not per pack item: the corpus dedupes hard. "Kya aapke paas
 * apne auzaar hain?" is authored in 99 packs and is ONE clip, so it is one row here.
 */
const QUESTION_TTS_TEXT: Readonly<Record<string, string>> = {
  "Aap kaunsi dukan par kaam karte hain?": "आप कौनसी दुकान पर काम करते हैं?",
  "Kya aap export line par kaam kar chuke hain?": "क्या आप एक्सपोर्ट लाइन पर काम कर चुके हैं?",
  "Kya aap khambe par chadh kar kaam karte hain?": "क्या आप खंभे पर चढ़ कर काम करते हैं?",
  "Aap kahaan kaam karte hain?": "आप कहाँ काम करते हैं?",
  "Kya aapke paas bijli ka licence hai?": "क्या आपके पास बिजली का लाइसेंस है?",
  "Kya aap lambi duri ja sakte hain?": "क्या आप लंबी दूरी जा सकते हैं?",
  "Kya aap overhead welding kar lete hain?": "क्या आप ओवरहेड वेल्डिंग कर लेते हैं?",
  "Aap kya thik karte hain?": "आप क्या ठीक करते हैं?",
  "Kya aap dulhan ka makeup karte hain?": "क्या आप दुल्हन का मेकअप करते हैं?",
  "Aap plant me kya karte hain?": "आप प्लांट में क्या करते हैं?",
  "Kya aap bhaari saman utha sakte hain?": "क्या आप भारी सामान उठा सकते हैं?",
  "Kya aap unchai par kaam karte hain?": "क्या आप ऊँचाई पर काम करते हैं?",
  "Aap ek shift me kitne piece karte hain?": "आप एक शिफ्ट में कितने पीस करते हैं?",
  "Kya aap soldering kar lete hain?": "क्या आप सोल्डरिंग कर लेते हैं?",
  "Kitne logon ka khana bana lete hain?": "कितने लोगों का खाना बना लेते हैं?",
  "Aap kaunsi badi gaadi chalate hain?": "आप कौनसी बड़ी गाड़ी चलाते हैं?",
  "Aapne kahaan tak padhai ki hai?": "आपने कहाँ तक पढ़ाई की है?",
  "Kya aap motor ya pump lagate hain?": "क्या आप मोटर या पंप लगाते हैं?",
  "Kya aap drawing padh lete hain?": "क्या आप ड्रॉइंग पढ़ लेते हैं?",
  "Kya aap safai ki machine chalate hain?": "क्या आप सफाई की मशीन चलाते हैं?",
  "Aapke paas kaunsa licence hai?": "आपके पास कौनसा लाइसेंस है?",
  "Aap kaunsi fasal ka kaam karte hain?": "आप कौनसी फसल का काम करते हैं?",
  "Aap kya assemble karte hain?": "आप क्या असेंबल करते हैं?",
  "Kya aap plant ki machine chalate hain?": "क्या आप प्लांट की मशीन चलाते हैं?",
  "Aap kis tarah ka fitting kaam karte hain?": "आप किस तरह का फिटिंग काम करते हैं?",
  "Kya aap garmi wali jagah kaam kar sakte hain?": "क्या आप गर्मी वाली जगह काम कर सकते हैं?",
  "Kya aap cash sambhalte hain?": "क्या आप कैश सँभालते हैं?",
  "Aap din ki shift chahte hain ya raat ki?": "आप दिन की शिफ्ट चाहते हैं या रात की?",
  "Abhi aap kaunse sheher mein hain?": "अभी आप कौनसे शहर में हैं?",
  "Aap kaunsi gaadi chalate hain?": "आप कौनसी गाड़ी चलाते हैं?",
  "Aap kaunsa chinai kaam karte hain?": "आप कौनसा चिनाई काम करते हैं?",
  "Aap dairy me kya karte hain?": "आप डेयरी में क्या करते हैं?",
  "Aap kaunsa kapda silte hain?": "आप कौनसा कपड़ा सिलते हैं?",
  "Kya aap nayi machine lagate hain?": "क्या आप नई मशीन लगाते हैं?",
  "Kya aap finishing ka kaam karte hain?": "क्या आप फिनिशिंग का काम करते हैं?",
  "Kya aap koi hunar seekh rahe hain?": "क्या आप कोई हुनर सीख रहे हैं?",
  "Kya aapke paas licence hai?": "क्या आपके पास लाइसेंस है?",
  "Kya aap quality check karte hain?": "क्या आप क्वालिटी चेक करते हैं?",
  "Aap kaunsa karghah chalate hain?": "आप कौनसा करघा चलाते हैं?",
  "Kya aap concrete ka grade jaante hain?": "क्या आप कंक्रीट का ग्रेड जानते हैं?",
  "Kya aap polish ka kaam karte hain?": "क्या आप पॉलिश का काम करते हैं?",
  "Aap kaunsi machine chalate hain?": "आप कौनसी मशीन चलाते हैं?",
  "Kya aap machine se silai karte hain?": "क्या आप मशीन से सिलाई करते हैं?",
  "Aap kya paint karte hain?": "आप क्या पेंट करते हैं?",
  "Kya aap engine kholte hain?": "क्या आप इंजन खोलते हैं?",
  "Kya aapne beauty ka course kiya hai?": "क्या आपने ब्यूटी का कोर्स किया है?",
  "Kya aap ghar par rehkar kaam kar sakte hain?": "क्या आप घर पर रहकर काम कर सकते हैं?",
  "Aap kaunse fuel ki gaadi par kaam karte hain?": "आप कौनसे फ्यूल की गाड़ी पर काम करते हैं?",
  "Kya aap programme feed kar lete hain?": "क्या आप प्रोग्राम फीड कर लेते हैं?",
  "Aap kaunsa kachra uthate hain?": "आप कौनसा कचरा उठाते हैं?",
  "Kya aap chip level ka kaam karte hain?": "क्या आप चिप लेवल का काम करते हैं?",
  "Kya aap stock sambhalte hain?": "क्या आप स्टॉक सँभालते हैं?",
  "Is kaam mein aapko kitne saal ho gaye?": "इस काम में आपको कितने साल हो गए?",
  "Kya aap taul ka kaam karte hain?": "क्या आप तौल का काम करते हैं?",
  "Kya aap sheher ke raaste jaante hain?": "क्या आप शहर के रास्ते जानते हैं?",
  "Kya aap kachra gaadi chalate hain?": "क्या आप कचरा गाड़ी चलाते हैं?",
  "Kya aap breakdown thik karte hain?": "क्या आप ब्रेकडाउन ठीक करते हैं?",
  "Kya aap gaadi ki wiring karte hain?": "क्या आप गाड़ी की वायरिंग करते हैं?",
  "Aap ek din me kitne piece kar lete hain?": "आप एक दिन में कितने पीस कर लेते हैं?",
  "Kya aap forklift chala lete hain?": "क्या आप फोर्कलिफ्ट चला लेते हैं?",
  "Aap pump par kya karte hain?": "आप पंप पर क्या करते हैं?",
  "Kya aap hathiyar wali duty kar sakte hain?": "क्या आप हथियार वाली ड्यूटी कर सकते हैं?",
  "Aap kaam kab se shuru kar sakte hain?": "आप काम कब से शुरू कर सकते हैं?",
  "Aap kya karte hain?": "आप क्या करते हैं?",
  "Aap kaunsi welding karte hain?": "आप कौनसी वेल्डिंग करते हैं?",
  "Kya aap ghar jaakar service dete hain?": "क्या आप घर जाकर सर्विस देते हैं?",
  "Kya aap chemical se safai karte hain?": "क्या आप केमिकल से सफाई करते हैं?",
  "Aap kahaan kaam karna chahte hain?": "आप कहाँ काम करना चाहते हैं?",
  "Aap kaunse maapne ke auzaar use karte hain?": "आप कौनसे मापने के औज़ार इस्तेमाल करते हैं?",
  "Kya aap masala banate hain?": "क्या आप मसाला बनाते हैं?",
  "Kya aap rotating shift kar sakte hain?": "क्या आप रोटेटिंग शिफ्ट कर सकते हैं?",
  "Aap kis mistri ke saath kaam karte hain?": "आप किस मिस्त्री के साथ काम करते हैं?",
  "Kya aap billing machine chala lete hain?": "क्या आप बिलिंग मशीन चला लेते हैं?",
  "Kya aap gas charging karte hain?": "क्या आप गैस चार्जिंग करते हैं?",
  "Kya aap billing kar lete hain?": "क्या आप बिलिंग कर लेते हैं?",
  "Aap kya chalate hain?": "आप क्या चलाते हैं?",
  "Aap hath se kaam karte hain ya machine se?": "आप हाथ से काम करते हैं या मशीन से?",
  "Kya aap season ke hisaab se kaam karte hain?": "क्या आप सीज़न के हिसाब से काम करते हैं?",
  "Aap kis tarah ka nal kaam karte hain?": "आप किस तरह का नल काम करते हैं?",
  "Kya aapne safai ki training li hai?": "क्या आपने सफाई की ट्रेनिंग ली है?",
  "Aap kaunsi machine par kaam kar chuke hain?": "आप कौनसी मशीन पर काम कर चुके हैं?",
  "Kya aap spray gun chalate hain?": "क्या आप स्प्रे गन चलाते हैं?",
  "Aap mahine ka kitna vetan chahte hain?": "आप महीने का कितना वेतन चाहते हैं?",
  "Kya aapke paas apne auzaar hain?": "क्या आपके पास अपने औज़ार हैं?",
  "Kya aap naap lete hain?": "क्या आप नाप लेते हैं?",
  "Kya aap kapda cutting karte hain?": "क्या आप कपड़ा कटिंग करते हैं?",
  "Kya aapke paas welding ka certificate hai?": "क्या आपके पास वेल्डिंग का सर्टिफिकेट है?",
  "Aap veg banate hain ya non-veg bhi?": "आप वेज बनाते हैं या नॉन-वेज भी?",
  "Kya aapke paas guard ka licence hai?": "क्या आपके पास गार्ड का लाइसेंस है?",
  "Aap kitne volt tak ka kaam karte hain?": "आप कितने वोल्ट तक का काम करते हैं?",
  "Kya aap raat ki duty kar sakte hain?": "क्या आप रात की ड्यूटी कर सकते हैं?",
  "Aap kahaan safai karte hain?": "आप कहाँ सफाई करते हैं?",
  "Aap kya bunte hain?": "आप क्या बुनते हैं?",
  "Aap kaunsa oven chalate hain?": "आप कौनसा ओवन चलाते हैं?",
  "Kya gaadi aapki apni hai?": "क्या गाड़ी आपकी अपनी है?",
  "Aap kya banate hain?": "आप क्या बनाते हैं?",
  "Aap kis cheez par kaam karte hain?": "आप किस चीज़ पर काम करते हैं?",
  "Kya aap English bol lete hain?": "क्या आप अंग्रेज़ी बोल लेते हैं?",
  "Kya aap doosre sheher jaa sakte hain?": "क्या आप दूसरे शहर जा सकते हैं?",
  "Aap kaunse material par kaam karte hain?": "आप कौनसे मटीरियल पर काम करते हैं?",
  "Aap kahaan guard ka kaam karte hain?": "आप कहाँ गार्ड का काम करते हैं?",
  "Kya aapki apni dukan hai?": "क्या आपकी अपनी दुकान है?",
  "Aap kaunsa ghar ka kaam karte hain?": "आप कौनसा घर का काम करते हैं?",
  "Aap din me kitne ghante kaam karte hain?": "आप दिन में कितने घंटे काम करते हैं?",
  "Aap kaunsi line par kaam karte hain?": "आप कौनसी लाइन पर काम करते हैं?",
  "Kya aap CCTV dekh sakte hain?": "क्या आप CCTV देख सकते हैं?",
  "Kya aap fine tolerance ka kaam karte hain?": "क्या आप फाइन टॉलरेंस का काम करते हैं?",
  "Aap kaise packing karte hain?": "आप कैसे पैकिंग करते हैं?",
  "Kya aap grahak se baat karte hain?": "क्या आप ग्राहक से बात करते हैं?",
  "Kya aap design bana lete hain?": "क्या आप डिज़ाइन बना लेते हैं?",
  "Kya aap mazdooron ko sambhalte hain?": "क्या आप मज़दूरों को सँभालते हैं?",
  "Aap kahaan khana banate hain?": "आप कहाँ खाना बनाते हैं?",
  "Aap kaunsa khana banate hain?": "आप कौनसा खाना बनाते हैं?",
  "Aap kaunsa kaam karte hain?": "आप कौनसा काम करते हैं?",
  "Kya aap sinchai ka kaam jaante hain?": "क्या आप सिंचाई का काम जानते हैं?",
  "Aap kaunsi service dete hain?": "आप कौनसी सर्विस देते हैं?",
  "Aap kis tarah ka kaam karte hain?": "आप किस तरह का काम करते हैं?",
  "Aap kis tarah ka bijli kaam karte hain?": "आप किस तरह का बिजली काम करते हैं?",
  "Kya aap stock ginte hain?": "क्या आप स्टॉक गिनते हैं?",
  "Aap kaunsi gaadi thik karte hain?": "आप कौनसी गाड़ी ठीक करते हैं?",
  "Kya aapne safety training li hai?": "क्या आपने सेफ्टी ट्रेनिंग ली है?",
  "Kya aap level aur sutli se kaam karte hain?": "क्या आप लेवल और सुतली से काम करते हैं?",
  "Aap kaunse pipe ka kaam karte hain?": "आप कौनसे पाइप का काम करते हैं?",
  "Aap factory mein kaam karte hain ya site par?": "आप फैक्ट्री में काम करते हैं या साइट पर?",
  "Kya aap tractor chala lete hain?": "क्या आप ट्रैक्टर चला लेते हैं?",
  "Aap kahaan loading karte hain?": "आप कहाँ लोडिंग करते हैं?",
  "Kya aap raat ki shift kar sakte hain?": "क्या आप रात की शिफ्ट कर सकते हैं?",
  "Aap kahaan service karte hain?": "आप कहाँ सर्विस करते हैं?",
  "Kya aap lakdi ki machine chalate hain?": "क्या आप लकड़ी की मशीन चलाते हैं?",
  "Aap kaunsa lakdi kaam karte hain?": "आप कौनसा लकड़ी काम करते हैं?",

  // --- retry_text (5 of 466 items carry one) --------------------------------
  "Mahine ka kitna milna chahiye?": "महीने का कितना मिलना चाहिए?",
  "Aap kaunse sheher mein rehte hain?": "आप कौनसे शहर में रहते हैं?",
  "Gas, arc, MIG ya TIG mein se kaunsi?": "गैस, आर्क, MIG या TIG में से कौनसी?",
  "Kis sheher mein kaam karna hai?": "किस शहर में काम करना है?",
  "Kitne saal se ye kaam kar rahe hain?": "कितने साल से ये काम कर रहे हैं?",
  // --- qp_cnc_turning@1 (role pack, CNC turning) ---
  "Turning ka kitna tajurba hai?": "टर्निंग का कितना तजुर्बा है?",
  // R10 §2.6 — the fresher branch (§11 #1: training, trade test, workshop machines, project
  // work). Authored twins, not transliterations: the clarify forms are COMPOSED from why + prompt
  // by the reader, so only these nine need a hand.
  "ITI ke workshop me kaunsi machine par kaam kiya hai?":
    "आईटीआई के वर्कशॉप में कौनसी मशीन पर काम किया है?",
  "Workshop me kaunsi machine chalayi thi?": "वर्कशॉप में कौनसी मशीन चलाई थी?",
  "Trade test diya hai?": "ट्रेड टेस्ट दिया है?",
  "Trade test ka kya status hai?": "ट्रेड टेस्ट का क्या स्टेटस है?",
  "ITI me kya banaya tha? Apne shabdon me bataiye.":
    "आईटीआई में क्या बनाया था? अपने शब्दों में बताइए।",
  "Workshop me kaunsa job ya project banaya tha?": "वर्कशॉप में कौनसा जॉब या प्रोजेक्ट बनाया था?",
  "Aap kaunsi turning machine chalate hain?": "आप कौनसी टर्निंग मशीन चलाते हैं?",
  "Machine par kaunsa controller lagaa hai?": "मशीन पर कौनसा कंट्रोलर लगा है?",
  "Kaunse turning operation aap karte hain?": "कौनसे टर्निंग ऑपरेशन आप करते हैं?",
  "Job pakadne ke liye kya use karte hain?": "जॉब पकड़ने के लिए क्या यूज़ करते हैं?",
  "Setting mein aap kya kya karte hain?": "सेटिंग में आप क्या क्या करते हैं?",
  "Aap kitni tolerance tak kaam kar lete hain?": "आप कितनी टॉलरेंस तक काम कर लेते हैं?",
  "Aap kis industry ke parts banate hain?": "आप किस इंडस्ट्री के पार्ट्स बनाते हैं?",
  "Programme ke saath aap kitna kaam karte hain?": "प्रोग्राम के साथ आप कितना काम करते हैं?",
  "Aapki machine mein kaunsa feature hai?": "आपकी मशीन में कौनसा फीचर है?",
  "Quality ka kaunsa kaam aap karte hain?": "क्वालिटी का कौनसा काम आप करते हैं?",
  "Machine problem mein aap kya theek karte hain?": "मशीन प्रॉब्लम में आप क्या ठीक करते हैं?",
  "Lagbhag kitne saal turning ka kaam kiya hai?": "लगभग कितने साल टर्निंग का काम किया है?",
  // --- qp_vmc_milling@1 (role pack, VMC milling) — R14 §3.1 ---------------------------
  //
  // ELEVEN PROMPTS AND TWO RETRIES. The other thirteen milling clips are clarify forms and
  // COMPOSE from these plus the why-texts below, which is why the authoring burden is 22 and
  // not 35 — and why a hand-written clarify entry would fail the "composes rather than
  // authored" case rather than help.
  //
  // SEVEN OF THE PACK'S PROMPTS NEEDED NOTHING AT ALL, because their Hinglish is byte-identical
  // to the turner's and the table is keyed by that text. Sharing a question vocabulary across
  // two role packs pays here in a way the R11 estimate did not model: it estimated ~28 twins
  // from a flat 1.83-per-question ratio and the measured burden is 22.
  "Aap kaunsi milling machine chalate hain?": "आप कौनसी मिलिंग मशीन चलाते हैं?",
  "Machine kitne axis ki hai?": "मशीन कितने एक्सिस की है?",
  "Machine par kaunsa kaam karte hain?": "मशीन पर कौनसा काम करते हैं?",
  "Job ko machine par kaise pakadte hain?": "जॉब को मशीन पर कैसे पकड़ते हैं?",
  "Kaunse material par kaam kiya hai?": "कौनसे मटीरियल पर काम किया है?",
  "Machine setting ka kaunsa kaam karte hain?": "मशीन सेटिंग का कौनसा काम करते हैं?",
  "Kaunse measuring instrument chala lete hain?": "कौनसे मेज़रिंग इंस्ट्रुमेंट चला लेते हैं?",
  "Programming ka kaam kitna karte hain?": "प्रोग्रामिंग का काम कितना करते हैं?",
  "Kis industry ke parts banaye hain?": "किस इंडस्ट्री के पार्ट्स बनाये हैं?",
  "Machine ki kaunsi dikkat aap sudhaar lete hain?": "मशीन की कौनसी दिक्कत आप सुधार लेते हैं?",
  "Milling ka kitna tajurba hai?": "मिलिंग का कितना तजुर्बा है?",
  // The two retries. The digits stay ASCII — a `hi-IN` voice reads them as Hindi numerals — and
  // only the word "axis" is transliterated, because lowercase Latin is exactly what the voice
  // cannot pronounce and what `question-tts-text.test.ts` refuses.
  "Lagbhag kitne saal milling ka kaam kiya hai?": "लगभग कितने साल मिलिंग का काम किया है?",
  "3-axis, 4-axis ya 5-axis, kaunsi machine par kaam kiya hai?":
    "3-एक्सिस, 4-एक्सिस या 5-एक्सिस, कौनसी मशीन पर काम किया है?",
  // --- qp_cnc_grinding@1 (role pack, CNC and conventional grinding) — Batch 1 -----------
  //
  // SEVEN PROMPTS AND ONE RETRY. The pack has eighteen items; the other eleven ask the same
  // thing as the turner and milling packs and reuse their served text VERBATIM, so their twins
  // are already above. That reuse is deliberate corpus hygiene rather than laziness: one
  // question wording per attribute key means one twin, and a second phrasing of "Kya aap
  // drawing padh lete hain?" would be a second clip to keep in step forever.
  //
  // INITIALISMS STAY LATIN — CNC is spelled out letter by letter by a hi-IN voice, which is how
  // a worker says it. "Grinding", "wheel", "setting" and "surface finish" are Devanagari:
  // they are the words the worker actually uses, and a hi-IN voice reads Latin as English.
  "Grinding ka kitna tajurba hai?": "ग्राइंडिंग का कितना तजुर्बा है?",
  "Lagbhag kitne saal grinding ka kaam kiya hai?": "लगभग कितने साल ग्राइंडिंग का काम किया है?",
  "Aap kaunsi grinding machine chalate hain?": "आप कौन सी ग्राइंडिंग मशीन चलाते हैं?",
  "Machine CNC hai ya conventional?": "मशीन CNC है या कन्वेंशनल?",
  "Kaunse grinding wheel istemaal karte hain?": "कौन से ग्राइंडिंग व्हील इस्तेमाल करते हैं?",
  "Setting ka kaunsa kaam khud karte hain?": "सेटिंग का कौन सा काम खुद करते हैं?",
  "Kitna surface finish nikaal lete hain?": "कितना सरफेस फिनिश निकाल लेते हैं?",
  "Wheel dressing kaise karte hain?": "व्हील ड्रेसिंग कैसे करते हैं?",
  // --- qp_cam_programming@1 (role pack, part programming — CAM seat and at-machine MDI) — Batch 1
  //
  // TEN PROMPTS AND TWO RETRIES ACROSS TEN KEYS. The pack has fourteen items; the other four
  // (`controller_brand`, `drawing_reading`, `trade_test_status`, `iti_project_work`) ask the same
  // thing as the turning, milling and grinding packs in the same words, so their twins are already
  // above. That reuse is the corpus hygiene this file exists to reward: one wording per attribute
  // key means one clip to keep in step, forever.
  //
  // "कैम" AND "कैड" ARE DEVANAGARI WHILE "MDI" IS LATIN, and the split is about how the words are
  // SAID rather than about how they are spelled. The rule in this file's header keeps an
  // initialism Latin when a Hindi speaker spells it out letter by letter — CNC, MIG, TIG, and MDI
  // here. CAM and CAD are not spelled out; a programmer says them as words, which is also how the
  // alias corpus writes them (कैम प्रोग्रामर, कैड). Left Latin they would be read as English.
  "Program aap CAM software par banate hain ya machine par?":
    "प्रोग्राम आप कैम सॉफ्टवेयर पर बनाते हैं या मशीन पर?",
  "CAM software par ya machine par MDI se program banate hain?":
    "कैम सॉफ्टवेयर पर या मशीन पर MDI से प्रोग्राम बनाते हैं?",
  "Programming ka kitna tajurba hai?": "प्रोग्रामिंग का कितना तजुर्बा है?",
  "Lagbhag kitne saal programming ka kaam kiya hai?": "लगभग कितने साल प्रोग्रामिंग का काम किया है?",
  "Aap kaunsa CAM software chalate hain?": "आप कौनसा कैम सॉफ्टवेयर चलाते हैं?",
  "Kaunsi machine ke liye program banate hain?": "कौनसी मशीन के लिए प्रोग्राम बनाते हैं?",
  "Program banate waqt kaunsa kaam karte hain?": "प्रोग्राम बनाते वक़्त कौनसा काम करते हैं?",
  "CAD model ke saath kaunsa kaam karte hain?": "कैड मॉडल के साथ कौनसा काम करते हैं?",
  "Post-processor ke saath aap kitna kaam karte hain?":
    "पोस्ट-प्रोसेसर के साथ आप कितना काम करते हैं?",
  "Program release se pehle simulation kaise karte hain?":
    "प्रोग्राम रिलीज़ से पहले सिमुलेशन कैसे करते हैं?",
  // --- qp_cad_drafting@1 and qp_draughting@1 (the drawing office) — Batch 1 -------------------
  //
  // TWO PACKS, ONE BLOCK, BECAUSE THEY SHARE SIX OF THEIR SERVED STRINGS. `qp_draughting` is the
  // unit-3118 router that catches the civil, electrical, architectural and structural draughtsmen
  // `qp_cad_drafting` deliberately does not claim, and it asks its software, drawing-type and
  // drawing-work questions in the mechanical pack's exact words — only its OPTION lists diverge.
  // Filing them together is what makes the sharing visible to the next author instead of inviting
  // a second phrasing of "Aap kis tarah ki drawing banate hain?".
  //
  // "आईटीआई" MATCHES ITS OWN SIBLING, the turner's "ITI me kya banaya tha?" twin above, rather
  // than the Latin-initialism rule that keeps CNC and MDI in Latin. The two conventions already
  // sit side by side in this table; a THIRD spelling of ITI in one file would be worse than the
  // inconsistency.
  "Drawing aur CAD ke kaam ka kitna tajurba hai?": "ड्रॉइंग और कैड के काम का कितना तजुर्बा है?",
  "Lagbhag kitne saal drawing ka kaam ya course kiya hai?":
    "लगभग कितने साल ड्रॉइंग का काम या कोर्स किया है?",
  "Aap kaunsa CAD software chalate hain?": "आप कौनसा कैड सॉफ्टवेयर चलाते हैं?",
  "Software ke kaunse module par kaam kiya hai?": "सॉफ्टवेयर के कौनसे मॉड्यूल पर काम किया है?",
  "Drawing ka kaunsa kaam khud karte hain?": "ड्रॉइंग का कौनसा काम खुद करते हैं?",
  "Drawing me kaunse standard ka istemaal karte hain?":
    "ड्रॉइंग में कौनसे स्टैंडर्ड का इस्तेमाल करते हैं?",
  "Aap kis tarah ki drawing banate hain?": "आप किस तरह की ड्रॉइंग बनाते हैं?",
  "Aap kaunsa output banakar dete hain?": "आप कौनसा आउटपुट बनाकर देते हैं?",
  "Kis line ki drawing banayi hai?": "किस लाइन की ड्रॉइंग बनाई है?",
  "Drawing banane ke liye aapko kya milta hai?": "ड्रॉइंग बनाने के लिए आपको क्या मिलता है?",
  "Doosron ki banayi drawing check karte hain?": "दूसरों की बनाई ड्रॉइंग चेक करते हैं?",
  "Design ka kaunsa kaam aap karte hain?": "डिज़ाइन का कौनसा काम आप करते हैं?",
  "CAD kahaan se seekha hai?": "कैड कहाँ से सीखा है?",
  "Training me kaunsa kaam khud kiya hai?": "ट्रेनिंग में कौनसा काम खुद किया है?",
  "Kis line ki drawing par padhai ki hai?": "किस लाइन की ड्रॉइंग पर पढ़ाई की है?",
  "Course ya ITI me kya banaya tha? Apne shabdon me bataiye.":
    "कोर्स या आईटीआई में क्या बनाया था? अपने शब्दों में बताइए।",
  "Aap mechanical, civil ya electrical, kis line me kaam karte hain?":
    "आप मैकेनिकल, सिविल या इलेक्ट्रिकल, किस लाइन में काम करते हैं?",
  "Kis line ki drawing banate hain, machine ki ya building ki?":
    "किस लाइन की ड्रॉइंग बनाते हैं, मशीन की या बिल्डिंग की?",

  // --- qp_conventional_machining@1 (the manual machine shop) — Batch 2 ------------------------
  "Khraad aur milling ka kitna tajurba hai?": "खराद और मिलिंग का कितना तजुर्बा है?",
  "Shop par aap kis level ka kaam karte hain?": "शॉप पर आप किस लेवल का काम करते हैं?",
  "Khraad par kitne bade job tak kaam kiya hai?": "खराद पर कितने बड़े जॉब तक काम किया है?",
  "Cutting tool khud grind karke banate hain?": "कटिंग टूल खुद ग्राइंड करके बनाते हैं?",
  "Kaunsa mushkil kaam aap kar lete hain?": "कौनसा मुश्किल काम आप कर लेते हैं?",
  "Lagbhag kitne saal machine par kaam kiya hai?": "लगभग कितने साल मशीन पर काम किया है?",
  "Khraad, milling ya drill, kaunsi machine chalate hain?": "खराद, मिलिंग या ड्रिल, कौनसी मशीन चलाते हैं?",
  "Helper, operator ya skilled machinist, kaunsa kaam karte hain?": "हेल्पर, ऑपरेटर या स्किल्ड मशीनिस्ट, कौनसा काम करते हैं?",
  "Turning, milling, drilling ya boring, kya kya karte hain?": "टर्निंग, मिलिंग, ड्रिलिंग या बोरिंग, क्या क्या करते हैं?",
  "MS, EN8 ya cast iron, kis par kaam kiya hai?": "MS, EN8 या कास्ट आयरन, किस पर काम किया है?",
  "Vernier, micrometer ya dial gauge, kya istemaal karte hain?": "वर्नियर, माइक्रोमीटर या डायल गेज, क्या इस्तेमाल करते हैं?",
  "Drawing dekh kar job bana lete hain?": "ड्राइंग देख कर जॉब बना लेते हैं?",
  "Job shop, auto parts ya pump valve, kis line me kaam kiya?": "जॉब शॉप, ऑटो पार्ट्स या पंप वाल्व, किस लाइन में काम किया?",
  "Sabse bada job kitne dia ka kiya hai?": "सबसे बड़ा जॉब कितने डाया का किया है?",
  "Job ki tolerance lagbhag kitni rakhte hain?": "जॉब की टॉलरेंस लगभग कितनी रखते हैं?",
  "Job set karna, tool set karna, kya khud karte hain?": "जॉब सेट करना, टूल सेट करना, क्या खुद करते हैं?",
  "Pehla piece check karna ya rejection dekhna, kya karte hain?": "पहला पीस चेक करना या रिजेक्शन देखना, क्या करते हैं?",
  "Belt, gear ya bearing ki dikkat kya khud theek karte hain?": "बेल्ट, गियर या बेयरिंग की दिक्कत क्या खुद ठीक करते हैं?",
  "HSS tool ki dhaar aap banate hain ya koi aur?": "HSS टूल की धार आप बनाते हैं या कोई और?",
  "Taper, gear cutting ya lamba shaft, kya bana lete hain?": "टेपर, गियर कटिंग या लंबा शाफ्ट, क्या बना लेते हैं?",
  "Workshop me khraad ya milling par kaam kiya tha?": "वर्कशॉप में खराद या मिलिंग पर काम किया था?",
  "ITI ka trade test pass kiya hai ya nahi?": "आईटीआई का ट्रेड टेस्ट पास किया है या नहीं?",
  "ITI me banaya hua koi job yaad hai?": "आईटीआई में बनाया हुआ कोई जॉब याद है?",

  // --- qp_tool_die_making@1 (the tool room) — Batch 2 -----------------------------------------
  "Tool room ka kitna tajurba hai?": "टूल रूम का कितना तजुर्बा है?",
  "Tool room me aapki abhi kaunsi post hai?": "टूल रूम में आपकी अभी कौनसी पोस्ट है?",
  "Aap kaunsa tooling banate hain?": "आप कौनसा टूलिंग बनाते हैं?",
  "Tool room me kaunsi machine chalate hain?": "टूल रूम में कौनसी मशीन चलाते हैं?",
  "Kaunse tool steel par kaam kiya hai?": "कौनसे टूल स्टील पर काम किया है?",
  "Tool room ka kaunsa kaam khud karte hain?": "टूल रूम का कौनसा काम खुद करते हैं?",
  "Kis industry ke liye tooling banayi hai?": "किस इंडस्ट्री के लिए टूलिंग बनाई है?",
  "EDM par aap kaunsa kaam karte hain?": "EDM पर आप कौनसा काम करते हैं?",
  "Die design ka kaunsa kaam karte hain?": "डाई डिज़ाइन का कौनसा काम करते हैं?",
  "Die ki kaunsi dikkat aap sudhaar lete hain?": "डाई की कौनसी दिक्कत आप सुधार लेते हैं?",
  "Heat treatment ka kaam aap kaise sambhaalte hain?": "हीट ट्रीटमेंट का काम आप कैसे सँभालते हैं?",
  "Kitne tonnage ki press par tryout kiya hai?": "कितने टनेज की प्रेस पर ट्रायआउट किया है?",
  "Lagbhag kitne saal tool room ka kaam kiya hai?": "लगभग कितने साल टूल रूम का काम किया है?",
  "Trainee, tool maker ya senior, kaunsi post hai?": "ट्रेनी, टूल मेकर या सीनियर, कौनसी पोस्ट है?",
  "Press tool, die ya fixture, kya banate hain?": "प्रेस टूल, डाई या फिक्सचर, क्या बनाते हैं?",
  "Grinder, EDM ya milling, kaunsi machine chalate hain?": "ग्राइंडर, EDM या मिलिंग, कौनसी मशीन चलाते हैं?",
  "OHNS, HCHCr ya EN31, kaunsa steel istemaal kiya hai?": "OHNS, HCHCr या EN31, कौनसा स्टील इस्तेमाल किया है?",
  "Assembly, tryout ya benchwork, kaunsa kaam karte hain?": "असेंबली, ट्रायआउट या बेंचवर्क, कौनसा काम करते हैं?",
  "Slip gauge, micrometer ya sine bar, kya chalate hain?": "स्लिप गेज, माइक्रोमीटर या साइन बार, क्या चलाते हैं?",
  "Tooling drawing dekh kar kaam kar lete hain?": "टूलिंग ड्रॉइंग देख कर काम कर लेते हैं?",
  "Die clearance kitni tolerance tak rakh lete hain?": "डाई क्लीयरेंस कितनी टॉलरेंस तक रख लेते हैं?",
  "Sheet metal, auto ya electrical, kis line ki tooling banayi?": "शीट मेटल, ऑटो या इलेक्ट्रिकल, किस लाइन की टूलिंग बनाई?",
  "Wire-cut program, electrode ya setting, kya karte hain?": "वायर-कट प्रोग्राम, इलेक्ट्रोड या सेटिंग, क्या करते हैं?",
  "Strip layout ya clearance nikalna, kya karte hain?": "स्ट्रिप लेआउट या क्लीयरेंस निकालना, क्या करते हैं?",
  "Burr, punch tootna ya strip jam, kya theek karte hain?": "बर्र, पंच टूटना या स्ट्रिप जाम, क्या ठीक करते हैं?",
  "Hardness khud check karte hain ya bahar bhijwate hain?": "हार्डनेस खुद चेक करते हैं या बाहर भिजवाते हैं?",
  "Chhoti press ya badi press, kis par tryout kiya hai?": "छोटी प्रेस या बड़ी प्रेस, किस पर ट्रायआउट किया है?",
  "Workshop me kaunsi machine par haath aazmaya hai?": "वर्कशॉप में कौनसी मशीन पर हाथ आज़माया है?",
  "Trade test ka result aa gaya hai?": "ट्रेड टेस्ट का रिज़ल्ट आ गया है?",
  "Kaunsa job ya model banaya tha ITI me?": "कौनसा जॉब या मॉडल बनाया था आईटीआई में?",

  // --- qp_welding_trade@1 (arc, MIG, TIG and gas welding) — Batch 2 ---------------------------
  "Welding ka kitna tajurba hai?": "वेल्डिंग का कितना तजुर्बा है?",
  "Aap khud ko kis level ka welder maante hain?": "आप खुद को किस लेवल का वेल्डर मानते हैं?",
  "Kaunsi welding machine par kaam karte hain?": "कौनसी वेल्डिंग मशीन पर काम करते हैं?",
  "Kaunsi rod ya wire istemaal karte hain?": "कौनसी रॉड या वायर इस्तेमाल करते हैं?",
  "Kaunse material par welding karte hain?": "कौनसे मटीरियल पर वेल्डिंग करते हैं?",
  "Kaunsi position me welding kar lete hain?": "कौनसी पोज़िशन में वेल्डिंग कर लेते हैं?",
  "Kitni moti plate par welding karte hain?": "कितनी मोटी प्लेट पर वेल्डिंग करते हैं?",
  "Weld ki checking ka kaunsa kaam karte hain?": "वेल्ड की चेकिंग का कौनसा काम करते हैं?",
  "Kis line ki fabrication me kaam kiya hai?": "किस लाइन की फैब्रिकेशन में काम किया है?",
  "Kaunse joint weld kar lete hain?": "कौनसे जॉइंट वेल्ड कर लेते हैं?",
  "Machine ki kaunsi setting khud karte hain?": "मशीन की कौनसी सेटिंग खुद करते हैं?",
  "Weld ki kaunsi kharabi aap sudhaar lete hain?": "वेल्ड की कौनसी खराबी आप सुधार लेते हैं?",
  "Welding ke alawa kaunsa kaam karte hain?": "वेल्डिंग के अलावा कौनसा काम करते हैं?",
  "Lagbhag kitne saal welding ka kaam kiya hai?": "लगभग कितने साल वेल्डिंग का काम किया है?",
  "Inverter, CO2 ya TIG machine, kaunsi chalayi hai?": "इनवर्टर, CO2 या TIG मशीन, कौनसी चलाई है?",

  // --- qp_powder_coating@1 (powder coating and industrial spray) — Batch 2 --------------------
  "Powder coating ya paint ka kitna tajurba hai?": "पाउडर कोटिंग या पेंट का कितना तजुर्बा है?",
  "Paint shop me aap kis level par kaam karte hain?": "पेंट शॉप में आप किस लेवल पर काम करते हैं?",
  "Aap kaunsa coating ka kaam karte hain?": "आप कौन सा कोटिंग का काम करते हैं?",
  "Kaunse booth aur oven par kaam kiya hai?": "कौन से बूथ और ओवन पर काम किया है?",
  "Kaunsa powder ya paint lagaya hai?": "कौन सा पाउडर या पेंट लगाया है?",
  "Coating se pehle kaunsi tayyari khud karte hain?": "कोटिंग से पहले कौन सी तैयारी खुद करते हैं?",
  "Coating ke baad kaunsi checking karte hain?": "कोटिंग के बाद कौन सी चेकिंग करते हैं?",
  "Booth batch wala hai ya conveyor line?": "बूथ बैच वाला है या कन्वेयर लाइन?",
  "Kitne micron ki coating thickness rakhte hain?": "कितने माइक्रोन की कोटिंग थिकनेस रखते हैं?",
  "Kis industry ke parts par coating ki hai?": "किस इंडस्ट्री के पार्ट्स पर कोटिंग की है?",
  "Kis dhaat par coating karte hain?": "किस धातु पर कोटिंग करते हैं?",
  "Gun ki kaunsi setting khud karte hain?": "गन की कौन सी सेटिंग खुद करते हैं?",
  "Curing oven kis temperature par chalate hain?": "क्योरिंग ओवन किस टेम्परेचर पर चलाते हैं?",
  "Coating ki kaunsi dikkat aap sudhaar lete hain?": "कोटिंग की कौन सी दिक्कत आप सुधार लेते हैं?",
  "Colour change ke waqt kaunsa kaam karte hain?": "कलर चेंज के वक़्त कौन सा काम करते हैं?",
  "Lagbhag kitne saal coating ka kaam kiya hai?": "लगभग कितने साल कोटिंग का काम किया है?",
  "Helper, operator ya skilled, kaunsa level hai?": "हेल्पर, ऑपरेटर या स्किल्ड, कौन सा लेवल है?",
  "Powder coating, spray ya touch-up, kya kaam karte hain?": "पाउडर कोटिंग, स्प्रे या टच-अप, क्या काम करते हैं?",
  "Powder booth, spray booth ya oven, kis par kaam kiya hai?": "पाउडर बूथ, स्प्रे बूथ या ओवन, किस पर काम किया है?",
  "Epoxy, polyester, PU ya primer, kya lagaya hai?": "एपॉक्सी, पॉलिएस्टर, PU या प्राइमर, क्या लगाया है?",
  "Degreasing, phosphating ya masking, kya karte hain?": "डीग्रीसिंग, फॉस्फेटिंग या मास्किंग, क्या करते हैं?",
  "DFT gauge, gloss meter ya adhesion test, kya karte hain?": "DFT गेज, ग्लॉस मीटर या एडहेजन टेस्ट, क्या करते हैं?",
  "Batch booth, conveyor line ya dono, kis par kaam kiya hai?": "बैच बूथ, कन्वेयर लाइन या दोनों, किस पर काम किया है?",
  "Lagbhag kitne micron DFT par kaam karte hain?": "लगभग कितने माइक्रोन DFT पर काम करते हैं?",
  "Auto parts, white goods ya furniture, kis line me kaam kiya hai?": "ऑटो पार्ट्स, व्हाइट गुड्स या फर्नीचर, किस लाइन में काम किया है?",
  "MS, GI, aluminium ya stainless, kis par coating ki hai?": "MS, GI, एल्युमिनियम या स्टेनलेस, किस पर कोटिंग की है?",
  "kV, powder flow ya gun distance, kya set karte hain?": "kV, पाउडर फ्लो या गन डिस्टेंस, क्या सेट करते हैं?",
  "Lagbhag kitne degree par curing karte hain?": "लगभग कितने डिग्री पर क्योरिंग करते हैं?",
  "Orange peel, patli coating ya blister, kya theek karte hain?": "ऑरेंज पील, पतली कोटिंग या ब्लिस्टर, क्या ठीक करते हैं?",
  "Booth safai, powder reclaim ya filter, kaunsa kaam karte hain?": "बूथ सफाई, पाउडर रिक्लेम या फिल्टर, कौन सा काम करते हैं?",
  "Spray gun, booth ya oven, kis par kaam kiya hai?": "स्प्रे गन, बूथ या ओवन, किस पर काम किया है?",
  "Trade test pass kiya hai ya abhi nahi diya?": "ट्रेड टेस्ट पास किया है या अभी नहीं दिया?",
  "ITI me banaya hua koi ek kaam bata dijiye.": "ITI में बनाया हुआ कोई एक काम बता दीजिए।",
};

/**
 * Roman → Devanagari for `why_text` — the ⓘ "yeh kyun poochh rahe hain" explanation.
 *
 * SEPARATE FROM THE QUESTIONS, because {@link composeClarify} needs to try these and only these
 * as the PREFIX of a clarify join. `joinClarify` puts the why first and the question second, so a
 * table that mixed them would happily match a question as a prefix and compose a sentence the
 * engine never said.
 */
const WHY_TTS_TEXT: Readonly<Record<string, string>> = {
  // R10 §2.6 — the fresher branch's three why-texts. They live HERE and not in the question table
  // because `composeClarify` scans this table and only this table for the PREFIX of a clarify
  // join; a why filed as a question is invisible to it and the clarify twin silently goes missing.
  "Training me chalayi hui machine bhi tajurba hai, employer ise dekhte hain.":
    "ट्रेनिंग में चलाई हुई मशीन भी तजुर्बा है, एम्प्लॉयर इसे देखते हैं।",
  "Trade test pass hona certificate jitna hi mayne rakhta hai.":
    "ट्रेड टेस्ट पास होना सर्टिफिकेट जितना ही मायने रखता है।",
  "Banaya hua job dikhata hai ki aap kya kar sakte hain.":
    "बनाया हुआ जॉब दिखाता है कि आप क्या कर सकते हैं।",
  "Har machine ka licence alag hota hai.": "हर मशीन का लाइसेंस अलग होता है।",
  "Doodh ke kaam me safai zaroori hai.": "दूध के काम में सफाई ज़रूरी है।",
  "Engine ka kaam alag rate par hota hai.": "इंजन का काम अलग रेट पर होता है।",
  "Har chinai kaam alag hota hai.": "हर चिनाई काम अलग होता है।",
  "Installation ka kaam alag milta hai.": "इंस्टॉलेशन का काम अलग मिलता है।",
  "Ghar aur factory ka kaam alag hai.": "घर और फैक्ट्री का काम अलग है।",
  "Fine kaam wale ka rate zyada hota hai.": "फाइन काम वाले का रेट ज़्यादा होता है।",
  "Armed guard ka vetan zyada hota hai.": "आर्म्ड गार्ड का वेतन ज़्यादा होता है।",
  "Machine wale ka kaam tez hota hai.": "मशीन वाले का काम तेज़ होता है।",
  "Har dukan ka kaam alag hota hai.": "हर दुकान का काम अलग होता है।",
  "Har gaadi ka licence alag hota hai.": "हर गाड़ी का लाइसेंस अलग होता है।",
  "Site par raat ka kaam aam hai.": "साइट पर रात का काम आम है।",
  "Line par target poocha jaata hai.": "लाइन पर टारगेट पूछा जाता है।",
  "Certificate se behtar vetan milta hai.": "सर्टिफिकेट से बेहतर वेतन मिलता है।",
  "Plant me safety zaroori hoti hai.": "प्लांट में सेफ्टी ज़रूरी होती है।",
  "Kaam ke hisaab se jagah dhoondhte hain.": "काम के हिसाब से जगह ढूँढते हैं।",
  "Banana aur marammat alag kaam hai.": "बनाना और मरम्मत अलग काम है।",
  "Banane wali cheez se hunar pata chalta hai.": "बनाने वाली चीज़ से हुनर पता चलता है।",
  "LT aur HT line ka kaam alag hai.": "LT और HT लाइन का काम अलग है।",
  "Safedi aur scaffolding alag hai.": "सफेदी और स्कैफोल्डिंग अलग है।",
  "Har gaadi ka kaam alag hota hai.": "हर गाड़ी का काम अलग होता है।",
  "Billing wale ko counter milta hai.": "बिलिंग वाले को काउंटर मिलता है।",
  "Chemical wale kaam ki training hoti hai.": "केमिकल वाले काम की ट्रेनिंग होती है।",
  "High voltage ka alag rate hota hai.": "हाई वोल्टेज का अलग रेट होता है।",
  "Season wale kaam ki timing alag hoti hai.": "सीज़न वाले काम की टाइमिंग अलग होती है।",
  "Furniture aur gaadi body alag hai.": "फर्नीचर और गाड़ी बॉडी अलग है।",
  "Jagah ke hisaab se sahi naukri dikhate hain.": "जगह के हिसाब से सही नौकरी दिखाते हैं।",
  "Har jagah ka kaam alag hota hai.": "हर जगह का काम अलग होता है।",
  "Plant me safety training zaroori hoti hai.": "प्लांट में सेफ्टी ट्रेनिंग ज़रूरी होती है।",
  "Chadhne wale ka kaam alag hota hai.": "चढ़ने वाले का काम अलग होता है।",
  "Forklift wale ka vetan zyada hota hai.": "फोर्कलिफ्ट वाले का वेतन ज़्यादा होता है।",
  "Har badi gaadi ka kaam alag hai.": "हर बड़ी गाड़ी का काम अलग है।",
  "Team sambhalne wale ka rate zyada hai.": "टीम सँभालने वाले का रेट ज़्यादा है।",
  "CCTV wale ko control room milta hai.": "CCTV वाले को कंट्रोल रूम मिलता है।",
  "Furniture aur shuttering alag hai.": "फर्नीचर और शटरिंग अलग है।",
  "Cutting master ka rate alag hota hai.": "कटिंग मास्टर का रेट अलग होता है।",
  "Drawing padhna zaroori hai kai jagah.": "ड्रॉइंग पढ़ना ज़रूरी है कई जगह।",
  "Kheti me kai tarah ke kaam hote hain.": "खेती में कई तरह के काम होते हैं।",
  "Bijli ke kaam me safety zaroori hai.": "बिजली के काम में सेफ्टी ज़रूरी है।",
  "Hath aur machine ka kaam alag hota hai.": "हाथ और मशीन का काम अलग होता है।",
  "Bina licence badi site par kaam nahi milta.": "बिना लाइसेंस बड़ी साइट पर काम नहीं मिलता।",
  "Har bakery item ka hunar alag hai.": "हर बेकरी आइटम का हुनर अलग है।",
  "Naap lena master darzi ka kaam hai.": "नाप लेना मास्टर दर्ज़ी का काम है।",
  "Billing wale ko counter ka kaam milta hai.": "बिलिंग वाले को काउंटर का काम मिलता है।",
  "Fitting ke kai tarah hote hain.": "फिटिंग के कई तरह होते हैं।",
  "Grade jaanne wale ko badi site milti hai.": "ग्रेड जानने वाले को बड़ी साइट मिलती है।",
  "Pump ka kaam alag se milta hai.": "पंप का काम अलग से मिलता है।",
  "Design wale ka rate zyada hota hai.": "डिज़ाइन वाले का रेट ज़्यादा होता है।",
  "Har jagah ka service alag hota hai.": "हर जगह का सर्विस अलग होता है।",
  "Rehne wale ka vetan alag hota hai.": "रहने वाले का वेतन अलग होता है।",
  "Pump par kai tarah ke kaam hote hain.": "पंप पर कई तरह के काम होते हैं।",
  "QC wale ko alag se rakha jaata hai.": "QC वाले को अलग से रखा जाता है।",
  "Har ghar ka kaam alag hota hai.": "हर घर का काम अलग होता है।",
  "Ghante ke hisaab se vetan tay hota hai.": "घंटे के हिसाब से वेतन तय होता है।",
  "Har fasal ka kaam alag hota hai.": "हर फसल का काम अलग होता है।",
  "Mixer aur plant ka kaam alag hai.": "मिक्सर और प्लांट का काम अलग है।",
  "Taul wale ko store me kaam milta hai.": "तौल वाले को स्टोर में काम मिलता है।",
  "AC aur fridge ka kaam alag hota hai.": "AC और फ्रिज का काम अलग होता है।",
  "Micrometer wale ko fine kaam milta hai.": "माइक्रोमीटर वाले को फाइन काम मिलता है।",
  "PVC aur GI ka kaam alag hota hai.": "PVC और GI का काम अलग होता है।",
  "Programme wale operator ko zyada vetan milta hai.":
    "प्रोग्राम वाले ऑपरेटर को ज़्यादा वेतन मिलता है।",
  "Licence wale ko badi company rakhti hai.": "लाइसेंस वाले को बड़ी कंपनी रखती है।",
  "Tool room me drawing zaroori hai.": "टूल रूम में ड्रॉइंग ज़रूरी है।",
  "Auto electrician ki alag maang hai.": "ऑटो इलेक्ट्रिशियन की अलग माँग है।",
  "Ghar aur building ka kaam alag hai.": "घर और बिल्डिंग का काम अलग है।",
  "Isse hum aapke kaam ke hisaab se sahi naukri dhoondh sakte hain.":
    "इससे हम आपके काम के हिसाब से सही नौकरी ढूँढ सकते हैं।",
  "Stock wale ko store ka kaam milta hai.": "स्टॉक वाले को स्टोर का काम मिलता है।",
  "Apni gaadi wale ki kamai alag hoti hai.": "अपनी गाड़ी वाले की कमाई अलग होती है।",
  "Die aur jig ka kaam alag hota hai.": "डाई और जिग का काम अलग होता है।",
  "Ghar aur hotel ka kaam alag hota hai.": "घर और होटल का काम अलग होता है।",
  "Tajurba dekhkar employer behtar offer dete hain.": "तजुर्बा देखकर एम्प्लॉयर बेहतर ऑफर देते हैं।",
  "Raat wali duty ka paisa zyada hota hai.": "रात वाली ड्यूटी का पैसा ज़्यादा होता है।",
  "Ghar aur gaadi ka paint alag hai.": "घर और गाड़ी का पेंट अलग है।",
  "Finishing se saman ka daam badhta hai.": "फिनिशिंग से सामान का दाम बढ़ता है।",
  "Har kapde ki silai alag hoti hai.": "हर कपड़े की सिलाई अलग होती है।",
  "Rickshaw aur thela alag kaam hai.": "रिक्शा और ठेला अलग काम है।",
  "Factory aur site ka kaam alag hota hai.": "फैक्ट्री और साइट का काम अलग होता है।",
  "Har jagah ki duty alag hoti hai.": "हर जगह की ड्यूटी अलग होती है।",
  "Raaste jaanne wale ko cab kaam milta hai.": "रास्ते जानने वाले को कैब काम मिलता है।",
  "Har jagah ki safai alag hoti hai.": "हर जगह की सफाई अलग होती है।",
  "Diesel aur petrol ka kaam alag hai.": "डीज़ल और पेट्रोल का काम अलग है।",
  "Har device ka kaam alag hota hai.": "हर डिवाइस का काम अलग होता है।",
  "Factory wale safety training wale ko pehle rakhte hain.":
    "फैक्ट्री वाले सेफ्टी ट्रेनिंग वाले को पहले रखते हैं।",
  "Jahaan aap kaam karna chahte hain, wahin ki naukri pehle dikhayenge.":
    "जहाँ आप काम करना चाहते हैं, वहीं की नौकरी पहले दिखाएँगे।",
  "Machine wale ko badi jagah kaam milta hai.": "मशीन वाले को बड़ी जगह काम मिलता है।",
  "Polish alag se paisa deta hai.": "पॉलिश अलग से पैसा देता है।",
  "Har machine ka kaam alag hota hai.": "हर मशीन का काम अलग होता है।",
  "Breakdown wale ko turant kaam milta hai.": "ब्रेकडाउन वाले को तुरंत काम मिलता है।",
  "Service ke hisaab se jagah dhoondhte hain.": "सर्विस के हिसाब से जगह ढूँढते हैं।",
  "Machine ka tajurba employer poochte hain.": "मशीन का तजुर्बा एम्प्लॉयर पूछते हैं।",
  "Machine ka naam employer poochte hain.": "मशीन का नाम एम्प्लॉयर पूछते हैं।",
  "Bhatti ke paas kaam mushkil hota hai.": "भट्टी के पास काम मुश्किल होता है।",
  "Aapke aas-paas ki naukri dikhane ke liye sheher zaroori hai.":
    "आपके आस-पास की नौकरी दिखाने के लिए शहर ज़रूरी है।",
  "Home service ki maang badh rahi hai.": "होम सर्विस की माँग बढ़ रही है।",
  "Gaadi chalane wale ka vetan alag hai.": "गाड़ी चलाने वाले का वेतन अलग है।",
  "Badi jagah English maangi jaati hai.": "बड़ी जगह अंग्रेज़ी माँगी जाती है।",
  "Piece rate wali jagah ye poochte hain.": "पीस रेट वाली जगह ये पूछते हैं।",
  "Course wale ko parlour jaldi rakhta hai.": "कोर्स वाले को पार्लर जल्दी रखता है।",
  "Bhatti aur mill ka kaam alag hai.": "भट्टी और मिल का काम अलग है।",
  "Kuch naukri ke liye padhai ka record maanga jaata hai.":
    "कुछ नौकरी के लिए पढ़ाई का रिकॉर्ड माँगा जाता है।",
  "Kai jagah bhaari kaam hota hai.": "कई जगह भारी काम होता है।",
  "Level ka kaam mistri ka hunar hai.": "लेवल का काम मिस्त्री का हुनर है।",
  "Licence bina gaadi ka kaam nahi milta.": "लाइसेंस बिना गाड़ी का काम नहीं मिलता।",
  "HMV bina badi gaadi nahi chala sakte.": "HMV बिना बड़ी गाड़ी नहीं चला सकते।",
  "Unchai wale kaam ka rate zyada hai.": "ऊँचाई वाले काम का रेट ज़्यादा है।",
  "Hath aur machine packing alag hai.": "हाथ और मशीन पैकिंग अलग है।",
  "Plant me shift badalti rehti hai.": "प्लांट में शिफ्ट बदलती रहती है।",
  "Employer ko pata hona chahiye ki aap kab mil sakte hain.":
    "एम्प्लॉयर को पता होना चाहिए कि आप कब मिल सकते हैं।",
  "Badi jagah bulk cooking maangi jaati hai.": "बड़ी जगह बल्क कुकिंग माँगी जाती है।",
  "Cash wale par bharosa chahiye hota hai.": "कैश वाले पर भरोसा चाहिए होता है।",
  "Machine wale ko plant me kaam milta hai.": "मशीन वाले को प्लांट में काम मिलता है।",
  "Oven ke hisaab se kaam milta hai.": "ओवन के हिसाब से काम मिलता है।",
  "Sinchai jaanne wale ki maang hai.": "सिंचाई जानने वाले की माँग है।",
  "Kai jagah sirf veg cook chahiye.": "कई जगह सिर्फ़ वेज कुक चाहिए।",
  "Mistri ke hisaab se kaam milta hai.": "मिस्त्री के हिसाब से काम मिलता है।",
  "Gas charging ek alag hunar hai.": "गैस चार्जिंग एक अलग हुनर है।",
  "Dairy me kai tarah ke kaam hote hain.": "डेयरी में कई तरह के काम होते हैं।",
  "Har service ka alag hunar hota hai.": "हर सर्विस का अलग हुनर होता है।",
  "Seekhne walon ko training wali jagah milti hai.": "सीखने वालों को ट्रेनिंग वाली जगह मिलती है।",
  "Shift ke hisaab se naukri chhaant kar dikhate hain.":
    "शिफ्ट के हिसाब से नौकरी छाँट कर दिखाते हैं।",
  "Kaleen aur kapda bunai alag hai.": "कालीन और कपड़ा बुनाई अलग है।",
  "Tractor wale ko zyada kaam milta hai.": "ट्रैक्टर वाले को ज़्यादा काम मिलता है।",
  "Chip level wale ka rate zyada hai.": "चिप लेवल वाले का रेट ज़्यादा है।",
  "Lambi duri ka paisa alag hota hai.": "लंबी दूरी का पैसा अलग होता है।",
  "Spray ka kaam alag hunar hai.": "स्प्रे का काम अलग हुनर है।",
  "Masala banane wale ki alag maang hai.": "मसाला बनाने वाले की अलग माँग है।",
  "Stock wale ko godam sambhalne milta hai.": "स्टॉक वाले को गोदाम सँभालने मिलता है।",
  "Har khane ka alag hunar hota hai.": "हर खाने का अलग हुनर होता है।",
  "Export line ka tajurba zyada maanga jaata hai.":
    "एक्सपोर्ट लाइन का तजुर्बा ज़्यादा माँगा जाता है।",
  "Licence wale ko badi jagah kaam milta hai.": "लाइसेंस वाले को बड़ी जगह काम मिलता है।",
  "Grahak se baat karne wale alag rakhe jaate hain.": "ग्राहक से बात करने वाले अलग रखे जाते हैं।",
  "Sahi vetan wali naukri hi dikhayenge.": "सही वेतन वाली नौकरी ही दिखाएँगे।",
  "Doosre sheher mein bhi achhi naukri mil sakti hai.": "दूसरे शहर में भी अच्छी नौकरी मिल सकती है।",
  "Machine se kaam tez hota hai.": "मशीन से काम तेज़ होता है।",
  "Bridal ka paisa sabse zyada hota hai.": "ब्राइडल का पैसा सबसे ज़्यादा होता है।",
  "Hathkargha aur power loom alag hai.": "हथकरघा और पावर लूम अलग है।",
  "Har product ki line alag hoti hai.": "हर प्रोडक्ट की लाइन अलग होती है।",
  "Soldering bina board ka kaam nahi hota.": "सोल्डरिंग बिना बोर्ड का काम नहीं होता।",
  "Apne auzaar wale ko kaam jaldi milta hai.": "अपने औज़ार वाले को काम जल्दी मिलता है।",
  "Dukan wale ko alag tarah ka kaam milta hai.": "दुकान वाले को अलग तरह का काम मिलता है।",
  "Overhead welding ka alag rate milta hai.": "ओवरहेड वेल्डिंग का अलग रेट मिलता है।",
  "Har welding alag hoti hai, isse sahi naukri milti hai.":
    "हर वेल्डिंग अलग होती है, इससे सही नौकरी मिलती है।",
  "Steel aur aluminium ka kaam alag hota hai.": "स्टील और एल्युमिनियम का काम अलग होता है।",
  "Har kachre ka kaam alag hota hai.": "हर कचरे का काम अलग होता है।",
  // --- qp_cnc_turning@1 (role pack, CNC turning) ---
  "Tajurbe ke hisaab se aage ke sawaal poochhe jaate hain.":
    "तजुर्बे के हिसाब से आगे के सवाल पूछे जाते हैं।",
  "Machine ke hisaab se sahi kaam dikhaya jaata hai.": "मशीन के हिसाब से सही काम दिखाया जाता है।",
  "Controller jaanne wale operator ko jaldi kaam milta hai.":
    "कंट्रोलर जानने वाले ऑपरेटर को जल्दी काम मिलता है।",
  "Operation se pata chalta hai aap kis level ka kaam karte hain.":
    "ऑपरेशन से पता चलता है आप किस लेवल का काम करते हैं।",
  "Job pakadna turning ka sabse zaroori hissa hai.": "जॉब पकड़ना टर्निंग का सबसे ज़रूरी हिस्सा है।",
  "Har material ka cutting alag hota hai.": "हर मटीरियल का कटिंग अलग होता है।",
  "Drawing padhna kai jagah zaroori hota hai.": "ड्राइंग पढ़ना कई जगह ज़रूरी होता है।",
  "Setting karne wale operator ko zyada vetan milta hai.":
    "सेटिंग करने वाले ऑपरेटर को ज़्यादा वेतन मिलता है।",
  "Tolerance se aapke kaam ki fine quality pata chalti hai.":
    "टॉलरेंस से आपके काम की फाइन क्वालिटी पता चलती है।",
  "Industry jaanne se milti julti company dikhayi jaati hai.":
    "इंडस्ट्री जानने से मिलती जुलती कंपनी दिखाई जाती है।",
  "Programme likhne wale ko sabse zyada vetan milta hai.":
    "प्रोग्राम लिखने वाले को सबसे ज़्यादा वेतन मिलता है।",
  "Yeh feature wali machine chalane wale kam milte hain.":
    "ये फीचर वाली मशीन चलाने वाले कम मिलते हैं।",
  "Quality ka kaam jaanne wale ko supervisor banaya jaata hai.":
    "क्वालिटी का काम जानने वाले को सुपरवाइज़र बनाया जाता है।",
  "Problem theek karne wale operator ki demand zyada hai.":
    "प्रॉब्लम ठीक करने वाले ऑपरेटर की डिमांड ज़्यादा है।",
  // --- qp_vmc_milling@1 (role pack, VMC milling) — R14 §3.1 ---------------------------
  //
  // NINE WHY-TEXTS. The tenth — "Tajurbe ke hisaab se aage ke sawaal poochhe jaate hain." — is
  // the turner's, shared verbatim because the experience gate asks the same thing of both
  // trades, so it is already above and needed no second entry.
  "Zyada axis wali machine chalane wale kam milte hain.":
    "ज़्यादा एक्सिस वाली मशीन चलाने वाले कम मिलते हैं।",
  "Kaam ke naam se employer samajhta hai aap kya kar sakte hain.":
    "काम के नाम से एम्प्लॉयर समझता है आप क्या कर सकते हैं।",
  "Workholding jaanna setting ka kaam dikhata hai.": "वर्कहोल्डिंग जानना सेटिंग का काम दिखाता है।",
  "Material ka tajurba employer ke liye alag mayne rakhta hai.":
    "मटीरियल का तजुर्बा एम्प्लॉयर के लिए अलग मायने रखता है।",
  "Setting karne wale ko operator se zyada paisa milta hai.":
    "सेटिंग करने वाले को ऑपरेटर से ज़्यादा पैसा मिलता है।",
  "Naap lene wale operator ko quality ka kaam diya jaata hai.":
    "नाप लेने वाले ऑपरेटर को क्वालिटी का काम दिया जाता है।",
  "Program likhne wale ko sabse zyada paisa milta hai.":
    "प्रोग्राम लिखने वाले को सबसे ज़्यादा पैसा मिलता है।",
  "Sector ka tajurba usi line ke employer dhoondhte hain.":
    "सेक्टर का तजुर्बा उसी लाइन के एम्प्लॉयर ढूँढते हैं।",
  "Dikkat sudhaarne wale operator ki shop par zaroorat rehti hai.":
    "दिक्कत सुधारने वाले ऑपरेटर की शॉप पर ज़रूरत रहती है।",
  // --- qp_cnc_grinding@1 (role pack) — Batch 1 -----------------------------------------
  //
  // FIVE WHY-TEXTS. The other thirteen are shared verbatim with the turner and milling packs
  // and are already above. Statements take the danda; only questions keep the Latin "?".
  "Dono ka kaam alag hota hai, dono ki demand hai.":
    "दोनों का काम अलग होता है, दोनों की डिमांड है।",
  "Wheel chunna grinding ka asli hunar hai.": "व्हील चुनना ग्राइंडिंग का असली हुनर है।",
  "Setting ka kaam operator aur setter ka farq batata hai.":
    "सेटिंग का काम ऑपरेटर और सेटर का फ़र्क़ बताता है।",
  "Finish grinding ke kaam ki sabse badi pehchaan hai.":
    "फिनिश ग्राइंडिंग के काम की सबसे बड़ी पहचान है।",
  "Dressing ka tarika wheel ki umar aur finish tay karta hai.":
    "ड्रेसिंग का तरीका व्हील की उम्र और फिनिश तय करता है।",
  // --- qp_cam_programming@1 (role pack) — Batch 1 --------------------------------------------
  //
  // FIVE WHY-TEXTS. The pack's other nine are the turner's, miller's and grinder's verbatim and
  // are already above — including "Tajurbe ke hisaab se aage ke sawaal poochhe jaate hain.", which
  // every role pack's tier gate now shares. Statements take the danda; only questions keep the
  // Latin "?".
  "Dono tarah ke programmer ki alag jagah zaroorat hoti hai.":
    "दोनों तरह के प्रोग्रामर की अलग जगह ज़रूरत होती है।",
  "Software ke hisaab se sahi kaam dikhaya jaata hai.":
    "सॉफ्टवेयर के हिसाब से सही काम दिखाया जाता है।",
  "Model theek kar lena programmer ka apna hunar hai.":
    "मॉडल ठीक कर लेना प्रोग्रामर का अपना हुनर है।",
  "Post-processor theek karne wale programmer kam milte hain.":
    "पोस्ट-प्रोसेसर ठीक करने वाले प्रोग्रामर कम मिलते हैं।",
  "Simulation se machine aur job ka nuksaan bachta hai.":
    "सिमुलेशन से मशीन और जॉब का नुक़सान बचता है।",
  // --- qp_cad_drafting@1 and qp_draughting@1 (the drawing office) — Batch 1 -------------------
  //
  // THIRTEEN WHY-TEXTS FOR THE TWO PACKS TOGETHER. "Software ke hisaab se sahi kaam dikhaya jaata
  // hai." is above with the CAM block — all three packs ask their software question with the same
  // explanation, which is one clip rather than three.
  //
  // TWO PAIRS HERE LOOK ALIKE AND ARE NOT. `sector_studied`'s "Jis line ki drawing seekhi hai…"
  // is the FRESHER's, and `sector_drawn`'s is the machining packs' "Sector ka tajurba usi line ke
  // employer dhoondhte hain." already above; likewise `iti_workshop_machines` diverges from the
  // machining wording because a CAD student's training is a drawing board and a computer lab. The
  // divergence is deliberate and costs exactly the two clips below.
  "Module se pata chalta hai aap kis tarah ki drawing banate hain.":
    "मॉड्यूल से पता चलता है आप किस तरह की ड्रॉइंग बनाते हैं।",
  "Standard ke hisaab se bani drawing seedha production me chali jaati hai.":
    "स्टैंडर्ड के हिसाब से बनी ड्रॉइंग सीधा प्रोडक्शन में चली जाती है।",
  "Drawing banane ka tarika employer ko aapka kaam samjhata hai.":
    "ड्रॉइंग बनाने का तरीका एम्प्लॉयर को आपका काम समझाता है।",
  "Output dekhkar employer samajhta hai aap kya kaam de sakte hain.":
    "आउटपुट देखकर एम्प्लॉयर समझता है आप क्या काम दे सकते हैं।",
  "Isse pata chalta hai aap sirf drawing banate hain ya design bhi karte hain.":
    "इससे पता चलता है आप सिर्फ़ ड्रॉइंग बनाते हैं या डिज़ाइन भी करते हैं।",
  "Part naap kar drawing banane wale ki alag zaroorat hoti hai.":
    "पार्ट नाप कर ड्रॉइंग बनाने वाले की अलग ज़रूरत होती है।",
  "Drawing check karne wale ko senior maana jaata hai.":
    "ड्रॉइंग चेक करने वाले को सीनियर माना जाता है।",
  "Design ka kaam jaanne wale ko design engineer banaya jaata hai.":
    "डिज़ाइन का काम जानने वाले को डिज़ाइन इंजीनियर बनाया जाता है।",
  "Training kahaan hui, ye employer sabse pehle dekhte hain.":
    "ट्रेनिंग कहाँ हुई, ये एम्प्लॉयर सबसे पहले देखते हैं।",
  "Training me kiya hua kaam bhi tajurba hai, employer ise dekhte hain.":
    "ट्रेनिंग में किया हुआ काम भी तजुर्बा है, एम्प्लॉयर इसे देखते हैं।",
  "Jis line ki drawing seekhi hai, wahi employer aapko dhoondhte hain.":
    "जिस लाइन की ड्रॉइंग सीखी है, वही एम्प्लॉयर आपको ढूँढते हैं।",
  "Banaya hua project dikhata hai ki aap kya kar sakte hain.":
    "बनाया हुआ प्रोजेक्ट दिखाता है कि आप क्या कर सकते हैं।",
  "Har line ki drawing ka kaam alag hota hai.": "हर लाइन की ड्रॉइंग का काम अलग होता है।",

  // --- qp_conventional_machining@1 (the manual machine shop) — Batch 2 ------------------------
  "Level se employer ko aapke kaam ka darja pata chalta hai.": "लेवल से एम्प्लॉयर को आपके काम का दर्जा पता चलता है।",
  "Badi machine chalane wale ko bade job ka kaam milta hai.": "बड़ी मशीन चलाने वाले को बड़े जॉब का काम मिलता है।",
  "Apna tool khud grind karna purana aur bada hunar hai.": "अपना टूल खुद ग्राइंड करना पुराना और बड़ा हुनर है।",
  "Mushkil kaam karne wale machinist ki alag pehchaan hoti hai.": "मुश्किल काम करने वाले मशीनिस्ट की अलग पहचान होती है।",

  // --- qp_tool_die_making@1 (the tool room) — Batch 2 -----------------------------------------
  "Post se employer ko aapka darja pehli line me samajh aata hai.": "पोस्ट से एम्प्लॉयर को आपका दर्जा पहली लाइन में समझ आता है।",
  "Aap kya banate hain, yahi employer sabse pehle dekhta hai.": "आप क्या बनाते हैं, यही एम्प्लॉयर सबसे पहले देखता है।",
  "Tool steel ka tajurba employer ke liye alag mayne rakhta hai.": "टूल स्टील का तजुर्बा एम्प्लॉयर के लिए अलग मायने रखता है।",
  "Khud kiya hua kaam helper aur tool maker ka farq batata hai.": "खुद किया हुआ काम हेल्पर और टूल मेकर का फ़र्क़ बताता है।",
  "EDM ka kaam tool room me alag hunar mana jaata hai.": "EDM का काम टूल रूम में अलग हुनर माना जाता है।",
  "Design samajhne wale tool maker ko senior kaam milta hai.": "डिज़ाइन समझने वाले टूल मेकर को सीनियर काम मिलता है।",
  "Dikkat sudhaarne wale tool maker ki shop par zaroorat rehti hai.": "दिक्कत सुधारने वाले टूल मेकर की शॉप पर ज़रूरत रहती है।",
  "Hardness sahi na ho to die jaldi toot jaati hai.": "हार्डनेस सही न हो तो डाई जल्दी टूट जाती है।",
  "Press ka size batata hai ki kitni badi tooling banayi hai.": "प्रेस का साइज़ बताता है कि कितनी बड़ी टूलिंग बनाई है।",

  // --- qp_welding_trade@1 (arc, MIG, TIG and gas welding) — Batch 2 ---------------------------
  "Helper aur certified welder ka kaam aur vetan alag hota hai.": "हेल्पर और सर्टिफाइड वेल्डर का काम और वेतन अलग होता है।",
  "Rod aur wire ka sahi chunaav welder ka hunar hai.": "रॉड और वायर का सही चुनाव वेल्डर का हुनर है।",
  "Moti plate ka kaam alag rate par hota hai.": "मोटी प्लेट का काम अलग रेट पर होता है।",
  "Checking jaanne wale welder ko quality ka kaam milta hai.": "चेकिंग जानने वाले वेल्डर को क्वालिटी का काम मिलता है।",
  "Joint ka tarika kaam ki mushkil batata hai.": "जॉइंट का तरीका काम की मुश्किल बताता है।",
  "Setting karne wale welder ko zyada vetan milta hai.": "सेटिंग करने वाले वेल्डर को ज़्यादा वेतन मिलता है।",
  "Kharabi sudhaarne wale welder ki shop par zaroorat rehti hai.": "खराबी सुधारने वाले वेल्डर की शॉप पर ज़रूरत रहती है।",
  "Poora fabrication jaanne wale ko shop me aage rakha jaata hai.": "पूरा फैब्रिकेशन जानने वाले को शॉप में आगे रखा जाता है।",

  // --- qp_powder_coating@1 (powder coating and industrial spray) — Batch 2 --------------------
  "Level se employer ko aapka darja saaf pata chalta hai.": "लेवल से एम्प्लॉयर को आपका दर्जा साफ़ पता चलता है।",
  "Process ke hisaab se sahi kaam dikhaya jaata hai.": "प्रोसेस के हिसाब से सही काम दिखाया जाता है।",
  "Equipment ka tajurba employer sabse pehle dekhte hain.": "इक्विपमेंट का तजुर्बा एम्प्लॉयर सबसे पहले देखते हैं।",
  "Tayyari ka kaam coating ki quality tay karta hai.": "तैयारी का काम कोटिंग की क्वालिटी तय करता है।",
  "Checking karne wale ko quality ka kaam diya jaata hai.": "चेकिंग करने वाले को क्वालिटी का काम दिया जाता है।",
  "Batch aur conveyor line ka kaam alag hota hai.": "बैच और कन्वेयर लाइन का काम अलग होता है।",
  "Thickness se coating ki quality aur cost tay hoti hai.": "थिकनेस से कोटिंग की क्वालिटी और कॉस्ट तय होती है।",
  "Dhaat ke hisaab se coating ka tarika badal jaata hai.": "धातु के हिसाब से कोटिंग का तरीका बदल जाता है।",
  "Gun setting se coating barabar lagti hai aur powder bachta hai.": "गन सेटिंग से कोटिंग बराबर लगती है और पाउडर बचता है।",
  "Oven ka temperature aur time coating ki jaan hai.": "ओवन का टेम्परेचर और टाइम कोटिंग की जान है।",
  "Colour change jaldi karne se line ka time bachta hai.": "कलर चेंज जल्दी करने से लाइन का टाइम बचता है।",
};

/** Every atomic pair, normalized once at module load — see {@link ttsTextFor}. */
const TTS_TEXT_BY_REPLY: ReadonlyMap<string, string> = new Map(
  [
    ...Object.entries(CONSTANT_TTS_TEXT),
    ...Object.entries(QUESTION_TTS_TEXT),
    ...Object.entries(WHY_TTS_TEXT),
  ].map(([roman, devanagari]) => [normalizeReplyText(roman), devanagari]),
);

/** The why-texts alone, normalized, for the clarify prefix scan. */
const WHY_BY_NORMALIZED: ReadonlyMap<string, string> = new Map(
  Object.entries(WHY_TTS_TEXT).map(([roman, dev]) => [normalizeReplyText(roman), dev]),
);

/** Devanagari codepoints — the check that an entry is actually in the target script. */
const DEVANAGARI_RE = /[ऀ-ॿ]/;

/**
 * A clarify turn's twin, composed from the pair it is made of.
 *
 * `joinClarify` builds a clarify reply as `why_text + " " + servedText(item, askNumber)` — 152 of
 * the closure's 439 clips are exactly that. Authoring those 152 by hand would mean writing out
 * every product of two tables we already hold, and every one of them would be free to disagree
 * with its own halves after a later edit. Composed here instead, so a clarify twin is correct by
 * construction or absent.
 *
 * SCANS THE WHY TABLE, NOT THE QUESTION TABLE, because the why is always the PREFIX. Trying
 * questions as prefixes could match the tail of a join and compose a sentence in the wrong order.
 *
 * Falls through to `undefined` unless BOTH halves are authored — a half-Devanagari, half-roman
 * sentence is worse than the romanized line the client already falls back to.
 */
function composeClarify(normalized: string): string | undefined {
  for (const [why, whyDevanagari] of WHY_BY_NORMALIZED) {
    const prefix = `${why} `;
    if (!normalized.startsWith(prefix)) continue;
    const question = TTS_TEXT_BY_REPLY.get(normalized.slice(prefix.length));
    if (question !== undefined) return `${whyDevanagari} ${question}`;
  }
  return undefined;
}

/**
 * The Devanagari twin of `reply`, or `undefined` when none is authored.
 *
 * NORMALIZED ON BOTH SIDES via `normalizeReplyText` — the same collapse the reply closure hashes
 * under — so a reply that picked up a line break or a doubled space on its way through the engine
 * still resolves. Anything beyond whitespace is a genuine miss and must stay one.
 *
 * PRE-INTERPOLATION. Call this with the raw engine reply, while `{{worker_name}}` is still a
 * placeholder; the Devanagari carries the identical placeholder and is rendered through the same
 * `renderPackText` as the shown text. Looking up AFTER interpolation would key on a string that
 * differs per worker and never match — and would put a real name in a lookup table.
 */
export function ttsTextFor(reply: string | null | undefined): string | undefined {
  if (!reply) return undefined;
  const normalized = normalizeReplyText(reply);
  return TTS_TEXT_BY_REPLY.get(normalized) ?? composeClarify(normalized);
}

/**
 * `{ tts_text }` for a reply, or `{}` when no twin is authored — spread straight into a response.
 *
 * THE SPREAD IS THE POINT: an unauthored reply yields a body with the key ABSENT rather than
 * present-and-null, which is the contract every `tts_text` field documents and the shape a client
 * reads as "speak the romanized text". For the chat surface use `ChatService.ttsField` instead —
 * it wraps this to render `{{worker_name}}` through the same path as the shown string.
 */
export function ttsField(reply: string | null | undefined): { tts_text?: string } {
  const devanagari = ttsTextFor(reply);
  return devanagari === undefined ? {} : { tts_text: devanagari };
}

/**
 * Every AUTHORED pair, for the tests that hold this file to the reply closure.
 *
 * Composed clarify twins are deliberately absent: they are derived, and a test that read them
 * back from here would be asserting the composition against itself.
 */
export const TTS_TEXT_ENTRIES: readonly (readonly [roman: string, devanagari: string])[] = [
  ...Object.entries(CONSTANT_TTS_TEXT),
  ...Object.entries(QUESTION_TTS_TEXT),
  ...Object.entries(WHY_TTS_TEXT),
];

/** The constants this file must cover, in `CONSTANT_REPLIES` order — see the test. */
export const TTS_CONSTANT_SOURCES: readonly string[] = [
  DE_ESCALATION_REPLY_TEXT,
  ...HARDSHIP_REPLY_TEXTS,
  CLOSING_REPLY_TEXT,
  CHAT_UNAVAILABLE_REPLY,
  DISAMBIGUATION_PROMPT_TEXT,
  CHAT_OPENING_TEXT,
];

export { DEVANAGARI_RE };
