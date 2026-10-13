/**
 * The profiling-stage free chat's fixed lines (ADR-0051 §5.1) — reviewed copy, never a model's.
 *
 * OWNER-APPROVED VERBATIM (2026-10-06; NEWS_CAP and NEWS_UNAVAILABLE 2026-10-08, ADR-0054 §5; the
 * reply-language lines LANG_ASK / LANG_YES / LANG_NO 2026-10-08, ADR-0051 §11).
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

import type { FreeChatRefusalTopic, FreeChatReplyLanguage } from "@badabhai/types";

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

// ---------------------------------------------------------------------------
// ADR-0051 §11 (R41, approved 2026-10-08) — the reply-language lines
// ---------------------------------------------------------------------------

/**
 * Each reply language's DISPLAY NAME (ADR-0051 §5.1): the Latin name the worker reads and the
 * Devanagari name the twin is read aloud with. `hinglish` is offered as "Hindi". In the closed
 * set's order; `free-chat.copy.test.ts` pins the keys to `FREE_CHAT_REPLY_LANGUAGES`.
 */
export const FREE_CHAT_LANGUAGE_NAMES = {
  english: { latin: "English", dev: "अंग्रेज़ी" },
  hinglish: { latin: "Hindi", dev: "हिंदी" },
  marathi: { latin: "Marathi", dev: "मराठी" },
  gujarati: { latin: "Gujarati", dev: "गुजराती" },
  kannada: { latin: "Kannada", dev: "कन्नड़" },
  telugu: { latin: "Telugu", dev: "तेलुगु" },
  tamil: { latin: "Tamil", dev: "तमिल" },
} as const satisfies Record<FreeChatReplyLanguage, FreeChatLine>;

/** The reply languages, in the closed set's order — read off the names, so no runtime import. */
const LANGUAGES = Object.keys(FREE_CHAT_LANGUAGE_NAMES) as FreeChatReplyLanguage[];

/** Where a language's display name goes in a template. */
const LANGUAGE_SLOT = "{Language}";

/**
 * The three reply-language lines AS APPROVED, `{Language}` still in them. Never served as they
 * stand: {@link languageAskLine} and {@link languageYesLine} fill the slot, and LANG_NO has none.
 */
export const FREE_CHAT_LANGUAGE_TEMPLATES = {
  LANG_ASK: {
    latin: "Kya aage ki saari baat {Language} mein karein?",
    dev: "क्या आगे की सारी बात {Language} में करें?",
  },
  LANG_YES: {
    latin: "Theek hai, ab se {Language} mein baat karenge.",
    dev: "ठीक है, अब से {Language} में बात करेंगे।",
  },
  LANG_NO: {
    latin: "Theek hai. Aap jis bhasha mein likhenge, usi mein jawab dunga.",
    dev: "ठीक है। आप जिस भाषा में लिखेंगे, उसी में जवाब दूँगा।",
  },
} as const satisfies Record<string, FreeChatLine>;

/** A template with `language`'s name in its slot — both halves, each with its own script's name. */
function filled(template: FreeChatLine, language: FreeChatReplyLanguage): FreeChatLine {
  const name = FREE_CHAT_LANGUAGE_NAMES[language];
  return {
    latin: template.latin.replace(LANGUAGE_SLOT, name.latin),
    dev: template.dev.replace(LANGUAGE_SLOT, name.dev),
  };
}

/** "Kya aage ki saari baat {Language} mein karein?" — appended to the requested-language reply. */
export function languageAskLine(language: FreeChatReplyLanguage): FreeChatLine {
  return filled(FREE_CHAT_LANGUAGE_TEMPLATES.LANG_ASK, language);
}

/** "Theek hai, ab se {Language} mein baat karenge." — the ask's Haan. */
export function languageYesLine(language: FreeChatReplyLanguage): FreeChatLine {
  return filled(FREE_CHAT_LANGUAGE_TEMPLATES.LANG_YES, language);
}

/** "Theek hai. Aap jis bhasha mein likhenge, usi mein jawab dunga." — the ask's Nahi. */
export const FREE_CHAT_LANG_NO_LINE: FreeChatLine = FREE_CHAT_LANGUAGE_TEMPLATES.LANG_NO;

/**
 * The ask's two chips (ADR-0051 §5.1), read ONLY while an ask is pending. Digit-free slugs, like
 * the three chips above.
 */
export const FREE_CHAT_LANG_YES_KEY = "free_chat_lang_yes";
export const FREE_CHAT_LANG_NO_KEY = "free_chat_lang_no";

/** "Haan, {Language} mein" — the yes chip's label, which the app posts back as the text. */
export function languageYesLabel(language: FreeChatReplyLanguage): string {
  return `Haan, ${FREE_CHAT_LANGUAGE_NAMES[language].latin} mein`;
}
export const FREE_CHAT_LANG_NO_LABEL = "Nahi";

/**
 * EVERY reply-language line the chat can serve, one per language where the line names one: the
 * seven asks, the seven yeses and the one no. Keyed `LANG_ASK.marathi` and so on.
 */
export const FREE_CHAT_LANGUAGE_LINE_ENTRIES: ReadonlyArray<readonly [string, FreeChatLine]> = [
  ...LANGUAGES.map((language) => [`LANG_ASK.${language}`, languageAskLine(language)] as const),
  ...LANGUAGES.map((language) => [`LANG_YES.${language}`, languageYesLine(language)] as const),
  ["LANG_NO", FREE_CHAT_LANG_NO_LINE] as const,
];

/**
 * EVERY FIXED LINE the free chat can serve — the §5.1 table and every reply-language variant. What
 * the closure, the Devanagari sidecar, the summary's fixed-line strip and the "not a question" set
 * read, so a line added to either list reaches all four.
 */
export const FREE_CHAT_FIXED_LINE_ENTRIES: ReadonlyArray<readonly [string, FreeChatLine]> = [
  ...FREE_CHAT_COPY_ENTRIES,
  ...FREE_CHAT_LANGUAGE_LINE_ENTRIES,
];

/** The Latin lines — what `CONSTANT_REPLIES` and `TTS_CONSTANT_SOURCES` enumerate. */
export const FREE_CHAT_REPLIES: readonly string[] = FREE_CHAT_FIXED_LINE_ENTRIES.map(
  ([, line]) => line.latin,
);

/**
 * Roman → Devanagari for the Devanagari sidecar. The two halves are the pair authored above, so
 * the sidecar cannot hold a twin that says something else.
 */
export const FREE_CHAT_TTS_ENTRIES: ReadonlyArray<readonly [roman: string, devanagari: string]> =
  FREE_CHAT_FIXED_LINE_ENTRIES.map(([, line]) => [line.latin, line.dev] as const);

/**
 * The lines a résumé-mode aside puts IN FRONT OF the pending question ("… + pending question",
 * ADR-0051 §5.1). The Devanagari sidecar composes their twin as `lead + " " + question` when both
 * halves are authored, the way it composes a clarify.
 */
export const FREE_CHAT_LEAD_LINES: readonly FreeChatLine[] = [
  FREE_CHAT_COPY.LOCK_DEFLECT,
  FREE_CHAT_COPY.LOCK_CLARIFY,
];
