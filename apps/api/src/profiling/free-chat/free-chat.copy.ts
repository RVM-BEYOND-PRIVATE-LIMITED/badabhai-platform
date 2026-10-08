/**
 * The profiling-stage free chat's fixed lines (ADR-0051 §5.1) — reviewed copy, never a model's.
 *
 * OWNER-APPROVED VERBATIM (2026-10-06; NEWS_CAP and NEWS_UNAVAILABLE 2026-10-08, ADR-0054 §5).
 * Every line here is served exactly as written: an edit is a
 * copy review, not a refactor. `free-chat.copy.test.ts` holds them to persona v3.2 ("aap", ≤20
 * words, ≤1 "?", no "!", no emoji, none of the banned tokens), and the only number in any line is
 * the Tele-MANAS helpline.
 *
 * EACH LINE IS A PAIR, the `companion-replies.ts` shape: `latin` is what the worker reads
 * (romanized Hinglish), `dev` is the same sentence in Devanagari for read-aloud (#896) — no
 * on-device voice pronounces romanized Hinglish. The pair is authored TOGETHER here, so an edit to
 * one half sits beside the other in the same diff.
 *
 * NO RUNTIME IMPORTS, like `identity-intake.copy.ts`: the reply closure (`reply-closure.ts`) and
 * the Devanagari sidecar (`question-tts-text.ts`) both enumerate these lines, and both are read by
 * processes that must not boot Nest.
 *
 * NAME-FREE. No `{{worker_name}}` anywhere: `assertNoInterpolation` fails the build on a
 * placeholder in the closure, and a free-chat line is the same for every worker.
 */

import type { FreeChatRefusalTopic } from "@badabhai/types";

/** One fixed line: what is shown, and what is read aloud. */
export interface FreeChatLine {
  readonly latin: string;
  readonly dev: string;
}

/** Every fixed line the free chat can serve, keyed as ADR-0051 §5.1 names them. */
export const FREE_CHAT_COPY = {
  GREETING: {
    latin: "Namaste, main Bada Bhai hoon. Aapka resume banane mein madad karunga. Shuru karein?",
    dev: "नमस्ते, मैं बड़ा भाई हूँ। आपका रिज़्यूमे बनाने में मदद करूँगा। शुरू करें?",
  },
  OPENER: {
    latin: "Theek hai. Aap kaun sa kaam karte hain, aur kitna tajurba hai?",
    dev: "ठीक है। आप कौन सा काम करते हैं, और कितना तजुर्बा है?",
  },
  LATER_ACK: {
    latin: "Theek hai. Jab mann ho, resume bana lenge. Tab tak kuch bhi poochhiye.",
    dev: "ठीक है। जब मन हो, रिज़्यूमे बना लेंगे। तब तक कुछ भी पूछिए।",
  },
  LOCK_DEFLECT: {
    latin: "Pehle resume bana lete hain, phir kuch aur baat karenge.",
    dev: "पहले रिज़्यूमे बना लेते हैं, फिर कुछ और बात करेंगे।",
  },
  LOCK_CLARIFY: {
    latin: "Samajh nahi aaya. Ek baar phir bataiye.",
    dev: "समझ नहीं आया। एक बार फिर बताइए।",
  },
  FREE_CLARIFY: {
    latin: "Samajh nahi aaya. Aap kya karna chahte hain?",
    dev: "समझ नहीं आया। आप क्या करना चाहते हैं?",
  },
  JOBS: {
    latin: "Jab aapki profile ban jayegi, tab aapke kaam ki jobs dikhayenge. Resume banayein?",
    dev: "जब आपकी प्रोफ़ाइल बन जाएगी, तब आपके काम की जॉब्स दिखाएँगे। रिज़्यूमे बनाएँ?",
  },
  CASUAL_NUDGE: {
    latin: "Waise, aapka resume bana dein? Kaam dhoondhne mein kaam aayega.",
    dev: "वैसे, आपका रिज़्यूमे बना दें? काम ढूँढने में काम आएगा।",
  },
  OFF_LIMITS: {
    latin: "Is baare mein main baat nahi karta. Kaam ya resume ki baat karein?",
    dev: "इस बारे में मैं बात नहीं करता। काम या रिज़्यूमे की बात करें?",
  },
  NEWS: {
    latin: "Taaza khabar abhi nahi bata sakta. Yeh suvidha jaldi aayegi.",
    dev: "ताज़ा ख़बर अभी नहीं बता सकता। यह सुविधा जल्दी आएगी।",
  },
  // ADR-0054 §5 (approved 2026-10-08) — live news. NEWS above stays the answer while the news task
  // is unarmed (its mock); these two are served once it is armed.
  NEWS_CAP: {
    latin: "Aaj ki khabrein ho gayin. Kal phir poochhiye. Tab tak resume bana lete hain?",
    dev: "आज की ख़बरें हो गईं। कल फिर पूछिए। तब तक रिज़्यूमे बना लेते हैं?",
  },
  NEWS_UNAVAILABLE: {
    latin: "Abhi taaza khabar nahi mil paayi. Thodi der baad phir poochhiye.",
    dev: "अभी ताज़ा ख़बर नहीं मिल पाई। थोड़ी देर बाद फिर पूछिए।",
  },
  LEGAL_MED_FIN: {
    latin:
      "Is baare mein kisi jaankar se salah lijiye. Main kaam aur resume mein madad karta hoon.",
    dev: "इस बारे में किसी जानकार से सलाह लीजिए। मैं काम और रिज़्यूमे में मदद करता हूँ।",
  },
  REPLY_FALLBACK: {
    latin: "Is par abhi kuch keh nahi paunga. Kaam ya resume ki koi baat poochhiye.",
    dev: "इस पर अभी कुछ कह नहीं पाऊँगा। काम या रिज़्यूमे की कोई बात पूछिए।",
  },
  TRASH_WARN: {
    latin: "Aisi bhasha theek nahi. Kaam ya resume ki baat karein.",
    dev: "ऐसी भाषा ठीक नहीं। काम या रिज़्यूमे की बात करें।",
  },
  TRASH_COOLDOWN: {
    latin: "Thodi der ke liye baat rok rahe hain. Tab tak resume bana sakte hain.",
    dev: "थोड़ी देर के लिए बात रोक रहे हैं। तब तक रिज़्यूमे बना सकते हैं।",
  },
  DISTRESS: {
    latin: "Aap akele nahi hain. Tele-MANAS 14416 par abhi baat kijiye, yeh muft hai.",
    dev: "आप अकेले नहीं हैं। टेली-मानस 14416 पर अभी बात कीजिए, यह मुफ़्त है।",
  },
  ASIDE_CAP: {
    latin: "Bahut baatein ho gayin. Ab aapka resume bana lete hain?",
    dev: "बहुत बातें हो गईं। अब आपका रिज़्यूमे बना लेते हैं?",
  },
} as const satisfies Record<string, FreeChatLine>;

export type FreeChatLineKey = keyof typeof FREE_CHAT_COPY;

/**
 * The three chips' keys (ADR-0051 §5.1). DIGIT-FREE SLUGS, so `QuestionPackOptionSchema` accepts
 * them and a replayed turn keeps its chips (`narrowLastTurn` parses options all-or-nothing). None
 * collides with an app-reserved key (`section_*`, `companion_*`, `resume_upload`, `kuch_aur` …).
 */
export const FREE_CHAT_START_KEY = "free_chat_start";
export const FREE_CHAT_LATER_KEY = "free_chat_later";
export const FREE_CHAT_RESUME_KEY = "free_chat_resume";

/** The chips' labels — what the app shows AND posts back as the message text. */
export const FREE_CHAT_START_LABEL = "Haan, shuru karein";
export const FREE_CHAT_LATER_LABEL = "Baad mein";
export const FREE_CHAT_RESUME_LABEL = "Resume banayein";

/**
 * A refusal topic → its reviewed line (ADR-0051 §3.4). The model chooses a TOPIC, never words;
 * `unsafe_other` (the catch-all, and what a mock reply returns) is the fail-closed line.
 */
export const FREE_CHAT_REFUSAL_LINES: Readonly<Record<FreeChatRefusalTopic, FreeChatLine>> = {
  legal_medical_financial: FREE_CHAT_COPY.LEGAL_MED_FIN,
  news: FREE_CHAT_COPY.NEWS,
  off_limits: FREE_CHAT_COPY.OFF_LIMITS,
  distress: FREE_CHAT_COPY.DISTRESS,
  unsafe_other: FREE_CHAT_COPY.REPLY_FALLBACK,
};

/** Every line as `[key, pair]`, for the copy lint and the two enumerations below. */
export const FREE_CHAT_COPY_ENTRIES: ReadonlyArray<readonly [FreeChatLineKey, FreeChatLine]> =
  Object.entries(FREE_CHAT_COPY) as Array<[FreeChatLineKey, FreeChatLine]>;

/** The Latin lines — what `CONSTANT_REPLIES` and `TTS_CONSTANT_SOURCES` enumerate. */
export const FREE_CHAT_REPLIES: readonly string[] = FREE_CHAT_COPY_ENTRIES.map(
  ([, line]) => line.latin,
);

/**
 * Roman → Devanagari for the Devanagari sidecar. The two halves are the pair authored above, so
 * the sidecar cannot hold a twin that says something else.
 */
export const FREE_CHAT_TTS_ENTRIES: ReadonlyArray<readonly [roman: string, devanagari: string]> =
  FREE_CHAT_COPY_ENTRIES.map(([, line]) => [line.latin, line.dev] as const);

/**
 * The lines a résumé-mode aside puts IN FRONT OF the pending question ("… + pending question",
 * ADR-0051 §5.1). The Devanagari sidecar composes their twin as `lead + " " + question` when both
 * halves are authored, the way it composes a clarify.
 */
export const FREE_CHAT_LEAD_LINES: readonly FreeChatLine[] = [
  FREE_CHAT_COPY.LOCK_DEFLECT,
  FREE_CHAT_COPY.LOCK_CLARIFY,
];
