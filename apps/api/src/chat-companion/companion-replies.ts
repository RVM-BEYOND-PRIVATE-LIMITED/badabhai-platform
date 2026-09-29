/**
 * Every line the companion can say (ADR-0044) — reviewed copy, never a model's.
 *
 * WHY CONSTANTS. The codebase's rule for fixed worker-facing lines is reviewed copy over a model
 * call (`CHAT_OPENING_TEXT`, the résumé menu): the same voice every time, reviewed once in a diff,
 * scanned by a test, free to serve. The companion only ever STATES facts the platform already
 * holds — a count, a road, a résumé's own glance — so there is nothing for a model to add.
 *
 * EACH LINE IS A PAIR. `latin` is what the worker reads (romanized Hinglish, the #1679 display
 * ruling); `dev` is the same sentence in Devanagari for read-aloud (#896), because no on-device
 * voice pronounces romanized Hinglish. Slots are filled into both with the same values, and only
 * integers and closed-set labels are ever slotted into `dev` — the one line whose slots are free
 * labels (the résumé glance: a role title, a city) carries a label-free twin instead, so a
 * Devanagari voice is never handed Latin words to mangle.
 *
 * NOT IN `CONSTANT_REPLIES`. That closure pre-renders every interview string to TTS audio and
 * refuses interpolation (`assertNoInterpolation`); these lines interpolate per worker and are
 * never pre-rendered. `companion-replies.test.ts` holds them to the persona rules instead.
 */
import { personaCorpus } from "@badabhai/profiling-lexicon";
import type { CompanionNudge, ResumeSource } from "@badabhai/types";

export interface CopyPair {
  readonly latin: string;
  readonly dev: string;
}

/** One rendered line: what is shown, and what is read aloud. */
export interface RenderedLine {
  readonly text: string;
  readonly tts: string;
}

export type SlotValue = number | string;

/** Fill `{name}` slots. A slot the template does not name is ignored; a missing one throws. */
export function fillSlots(template: string, slots: Readonly<Record<string, SlotValue>> = {}): string {
  return template.replace(/\{([a-z]+)\}/g, (_whole, name: string) => {
    const value = slots[name];
    if (value === undefined) throw new Error(`companion copy: slot {${name}} was not filled`);
    return String(value);
  });
}

export function render(pair: CopyPair, slots: Readonly<Record<string, SlotValue>> = {}): RenderedLine {
  return { text: fillSlots(pair.latin, slots), tts: fillSlots(pair.dev, slots) };
}

// ── The recap ────────────────────────────────────────────────────────────────────────────────

export const LEAD: CopyPair = {
  latin: "Namaste. Aapki profile taiyaar hai. Ab tak yeh hua hai.",
  dev: "नमस्ते। आपकी प्रोफ़ाइल तैयार है। अब तक यह हुआ है।",
};

/** How the résumé was made — `generated_resumes.generation_source`. `unknown` = pre-0125 row. */
export const ROAD: Readonly<Record<ResumeSource | "unknown", CopyPair>> = {
  chat: {
    latin: "Aapka resume chat se bana hai.",
    dev: "आपका रिज़्यूमे चैट से बना है।",
  },
  form: {
    latin: "Aapka resume form se bana hai.",
    dev: "आपका रिज़्यूमे फ़ॉर्म से बना है।",
  },
  resume_upload: {
    latin: "Aapka resume aapke upload kiye resume se bana hai.",
    dev: "आपका रिज़्यूमे आपके अपलोड किए रिज़्यूमे से बना है।",
  },
  unknown: {
    latin: "Aapka resume ban chuka hai.",
    dev: "आपका रिज़्यूमे बन चुका है।",
  },
};

/**
 * What the current résumé says, AS THAT RÉSUMÉ RECORDED IT (ADR-0043 §3.6 — its glance, never
 * today's profile). `{facts}` is a comma list of labels, so the twin names none of them — and it
 * claims nothing about WHICH facts are there, because the shown line lists only those present (a
 * glance may have no role, no tenure, only a city; tts_text is the same content, #896).
 */
export const GLANCE: CopyPair = {
  latin: "Resume mein: {facts}.",
  dev: "आपके रिज़्यूमे में आपकी जानकारी लिखी है।",
};

export const RESUME_BUILDING: CopyPair = {
  latin: "Aapka resume ban raha hai. Thodi der mein Resume tab mein dikhega.",
  dev: "आपका रिज़्यूमे बन रहा है। थोड़ी देर में रिज़्यूमे टैब में दिखेगा।",
};

export const RESUME_UPDATING: CopyPair = {
  latin: "Aapka resume update ho raha hai. Thodi der mein Resume tab mein dikhega.",
  dev: "आपका रिज़्यूमे अपडेट हो रहा है। थोड़ी देर में रिज़्यूमे टैब में दिखेगा।",
};

export const RESUME_UPDATE_FAILED: CopyPair = {
  latin: "Resume update poora nahi hua. Resume tab se dobara koshish karein.",
  dev: "रिज़्यूमे अपडेट पूरा नहीं हुआ। रिज़्यूमे टैब से दोबारा कोशिश करें।",
};

/**
 * The current row's render ended at `failed`: there is no PDF (`GET /resume/:id/download` answers
 * 409) and the Resume tab's history pill says NAHI BANI. "Bana hai" would contradict both, and no
 * retry is promised because not every failure has one a worker can press.
 */
export const RESUME_RENDER_FAILED: CopyPair = {
  latin: "Aapka resume abhi download nahi ho sakta. Resume tab mein dekhein.",
  dev: "आपका रिज़्यूमे अभी डाउनलोड नहीं हो सकता। रिज़्यूमे टैब में देखें।",
};

export const APPLIED_NONE: CopyPair = {
  latin: "Aapne abhi tak kisi job par apply nahi kiya hai.",
  dev: "आपने अभी तक किसी जॉब पर अप्लाई नहीं किया है।",
};
export const APPLIED_ONE: CopyPair = {
  latin: "Aapne ab tak 1 job par apply kiya hai.",
  dev: "आपने अब तक 1 जॉब पर अप्लाई किया है।",
};
export const APPLIED_MANY: CopyPair = {
  latin: "Aapne ab tak {n} jobs par apply kiya hai.",
  dev: "आपने अब तक {n} जॉब्स पर अप्लाई किया है।",
};

/** "Aapke kaam ke" is a skill-overlap claim — served ONLY when the worker's wanted skills matched. */
export const NEW_JOBS_NONE: CopyPair = {
  latin: "Pichhle {d} din mein aapke kaam ka koi naya job nahi aaya.",
  dev: "पिछले {d} दिन में आपके काम का कोई नया जॉब नहीं आया।",
};
export const NEW_JOBS_ONE: CopyPair = {
  latin: "Pichhle {d} din mein aapke kaam ka 1 naya job aaya hai.",
  dev: "पिछले {d} दिन में आपके काम का 1 नया जॉब आया है।",
};
export const NEW_JOBS_MANY: CopyPair = {
  latin: "Pichhle {d} din mein aapke kaam ke {n} naye jobs aaye hain.",
  dev: "पिछले {d} दिन में आपके काम के {n} नए जॉब्स आए हैं।",
};
/** At the count cap: "{cap} se zyada", so a rendered count never claims more precision than read. */
export const NEW_JOBS_CAPPED: CopyPair = {
  latin: "Pichhle {d} din mein aapke kaam ke {n} se zyada naye jobs aaye hain.",
  dev: "पिछले {d} दिन में आपके काम के {n} से ज़्यादा नए जॉब्स आए हैं।",
};
/** A worker with no wanted skills: nothing can honestly be called "aapke kaam ka". */
export const NO_SKILLS: CopyPair = {
  latin: "Naye jobs dekhne ke liye Jobs tab kholein.",
  dev: "नए जॉब्स देखने के लिए जॉब्स टैब खोलें।",
};
/** The jobs read failed: say so plainly and point at the tab, never a false zero. */
export const JOBS_UNAVAILABLE: CopyPair = {
  latin: "Abhi naye jobs nahi dikha pa rahe. Jobs tab mein dekhein.",
  dev: "अभी नए जॉब्स नहीं दिखा पा रहे। जॉब्स टैब में देखें।",
};

// ── The one nudge line ───────────────────────────────────────────────────────────────────────

/**
 * `resume_pending` carries no line of its own: the building/updating line above IS the nudge, and
 * repeating it would say the same thing twice.
 */
export const NUDGE_LINES: Readonly<Record<Exclude<CompanionNudge, "resume_pending">, CopyPair>> = {
  apply_first: {
    latin: "Neeche diye jobs mein se ek chunkar apply karein.",
    dev: "नीचे दिए जॉब्स में से एक चुनकर अप्लाई करें।",
  },
  apply_new: {
    latin: "Naye jobs dekhkar apply kar sakte hain.",
    dev: "नए जॉब्स देखकर अप्लाई कर सकते हैं।",
  },
  complete_profile: {
    latin: "Profile mein {field} jodne se resume behtar banega.",
    dev: "प्रोफ़ाइल में {field} जोड़ने से रिज़्यूमे बेहतर बनेगा।",
  },
};

/**
 * The profile gaps a worker can actually fill, in the order the profile summary reports them
 * (`computeMissingFields`). Deliberately absent, so they are never nudged:
 *   - `role` / `trade` — no canonical id, not something a worker can type in;
 *   - `photo` — the companion never reads the workers row;
 *   - `machines` — the summary reports it for EVERY empty list, whatever the trade, so a cook, a
 *     mason or a helper would be told their résumé is weaker for lacking machines their work
 *     never involves (and it would shadow their real gaps behind it).
 * The label is slotted into BOTH scripts, hence a pair per field.
 */
export const MISSING_FIELD_LABELS: Readonly<Record<string, CopyPair>> = {
  skills: { latin: "apni skills", dev: "अपनी स्किल्स" },
  experience: { latin: "apna tajurba", dev: "अपना तजुर्बा" },
  salary: { latin: "salary ki ummeed", dev: "सैलरी की उम्मीद" },
  location: { latin: "kaam ki jagah", dev: "काम की जगह" },
  availability: { latin: "joining ki jaankari", dev: "जॉइनिंग की जानकारी" },
};

export const ALL_SET: CopyPair = {
  latin: "Abhi sab theek hai. Naye jobs ke liye Jobs tab dekhte rahein.",
  dev: "अभी सब ठीक है। नए जॉब्स के लिए जॉब्स टैब देखते रहें।",
};

// ── Replies to a message ─────────────────────────────────────────────────────────────────────

export const JOBS_LIST_TAIL: CopyPair = {
  latin: "Kisi job par dabakar poori jaankari dekhein.",
  dev: "किसी जॉब पर दबाकर पूरी जानकारी देखें।",
};
export const JOBS_NONE_TAIL: CopyPair = {
  latin: "Sabhi jobs Jobs tab mein hain.",
  dev: "सभी जॉब्स जॉब्स टैब में हैं।",
};
export const APPLIED_LIST_TAIL: CopyPair = {
  latin: "Poori list neeche ke button se dekhein.",
  dev: "पूरी लिस्ट नीचे के बटन से देखें।",
};
export const FALLBACK: CopyPair = {
  latin: "Main aapke resume, applications aur naye jobs mein madad kar sakta hoon. Neeche se chunein.",
  dev: "मैं आपके रिज़्यूमे, एप्लिकेशन्स और नए जॉब्स में मदद कर सकता हूँ। नीचे से चुनें।",
};

/**
 * "Job milegi?" — the persona's honest refusal, VERBATIM (persona v3.2: a commitment, never
 * reworded). No Devanagari twin is authored for it anywhere, so it is read aloud as written.
 */
export function guaranteeLine(): string {
  return personaCorpus().guaranteeLine;
}

// ── Companion v2 — the router's fixed lines (ADR-0046 Phase 1) ───────────────────────────────
//
// The v2 pipeline answers a classified intent with one of these. They are constants for the same
// reason every line above is: the model CLASSIFIES, it never phrases (ADR-0046 §2). A line whose
// phase is not built yet says so — the owner's wording, O2 — and never pretends the capability
// exists. Every one carries its Devanagari twin and is scanned by `companion-replies.test.ts`.

/** An intent whose phase is not built yet. The owner's wording (ADR-0046 O2). */
export const V2_PHASE_OFF: CopyPair = {
  latin: "Yeh feature abhi aana baaki hai. Aap kisi aur baare mein baat kar sakte hain.",
  dev: "यह फ़ीचर अभी आना बाकी है। आप किसी और बारे में बात कर सकते हैं।",
};

/** A jobs question in chat: deferred by O2, and distinct from the phase-off line by name. */
export const V2_JOBS_DEFERRED: CopyPair = {
  latin: "Chat se jobs dhoondhna abhi aana baaki hai. Aap kisi aur baare mein baat kar sakte hain.",
  dev: "चैट से जॉब्स ढूँढना अभी आना बाकी है। आप किसी और बारे में बात कर सकते हैं।",
};

/** The classifier could not place the message (or the model failed): ask, with task chips. */
export const V2_CLARIFY: CopyPair = {
  latin: "Samajh nahi aaya. Aap inme se kya karna chahte hain?",
  dev: "समझ नहीं आया। आप इनमें से क्या करना चाहते हैं?",
};

/** An edit card was stored: the worker reviews the rows and taps Haan or Nahi. */
export const V2_EDIT_CARD_INTRO: CopyPair = {
  latin: "Yeh badlav karne hain? Dekh kar Haan dabaiye.",
  dev: "ये बदलाव करने हैं? देख कर हाँ दबाइए।",
};

/** No row survived validation: nothing was proposed, and nothing is claimed to have changed. */
export const V2_EDIT_NONE: CopyPair = {
  latin: "Kya badalna hai, samajh nahi aaya. Thoda aur batayiye.",
  dev: "क्या बदलना है, समझ नहीं आया। थोड़ा और बताइए।",
};

/** Identity/contact is out of scope (O3): the settings/Profile screen owns it. */
export const V2_EDIT_IDENTITY: CopyPair = {
  latin: "Naam aur phone Profile mein jaa kar badliye.",
  dev: "नाम और फ़ोन प्रोफ़ाइल में जा कर बदलिए।",
};

/** Haan: the rows were applied in one transaction and the résumé regeneration is queued. */
export const V2_EDIT_DONE: CopyPair = {
  latin: "Badlav ho gaya. Aapka resume update ho raha hai.",
  dev: "बदलाव हो गया। आपका रिज़्यूमे अपडेट हो रहा है।",
};

/** Applied, but the daily cap refused the regeneration (or it failed): the edits are written. */
export const V2_EDIT_DONE_CAPPED: CopyPair = {
  latin: "Badlav ho gaya. Resume aaj update nahi ho sakta, kal ho jayega.",
  dev: "बदलाव हो गया। रिज़्यूमे आज अपडेट नहीं हो सकता, कल हो जाएगा।",
};

/** Nahi: the card was dismissed and NOTHING was written. */
export const V2_EDIT_CANCELLED: CopyPair = {
  latin: "Theek hai, kuch nahi badla.",
  dev: "ठीक है, कुछ नहीं बदला।",
};

/** The profile moved under the card: nothing was written, and the worker is asked again. */
export const V2_EDIT_STALE: CopyPair = {
  latin: "Profile beech mein badal gaya. Dobara bataiye kya badalna hai.",
  dev: "प्रोफ़ाइल बीच में बदल गया। दोबारा बताइए क्या बदलना है।",
};

/** The proposal store refused the card (contracts §7): no card is offered, nothing is claimed. */
export const V2_EDIT_UNAVAILABLE: CopyPair = {
  latin: "Abhi badlav nahi ho paaya, thodi der mein try karein.",
  dev: "अभी बदलाव नहीं हो पाया, थोड़ी देर में ट्राई करें।",
};

// ── Companion v2 — faltu (ADR-0046 P2, O11) ──────────────────────────────────────────────────

/**
 * Strikes 1–2: the message was trash talk or noise. No lecture, no echo of what was said — the
 * line redirects to what the tab is for and the task chips stay open (a worker must always be
 * able to reach the résumé and jobs).
 */
export const V2_FALTU_REDIRECT: CopyPair = {
  latin: "Main resume aur kaam mein madad karta hoon. Inme se kuch chuniye.",
  dev: "मैं रिज़्यूमे और काम में मदद करता हूँ। इनमें से कुछ चुनिए।",
};

/**
 * The cool-down line (strike 3, then every free-text message until the window passes). Fixed
 * copy only — a model must never answer an abusive message — and the chips stay open so the
 * cool-down blocks free text, not the worker.
 */
export const V2_FALTU_COOLDOWN: CopyPair = {
  latin: "Thodi der baad baat karte hain.",
  dev: "थोड़ी देर बाद बात करते हैं।",
};

/** Every pair above, for the persona and twin tests. */
export const ALL_COPY_PAIRS: ReadonlyArray<readonly [name: string, pair: CopyPair]> = [
  ["LEAD", LEAD],
  ...Object.entries(ROAD).map(([k, v]) => [`ROAD.${k}`, v] as const),
  ["GLANCE", GLANCE],
  ["RESUME_BUILDING", RESUME_BUILDING],
  ["RESUME_UPDATING", RESUME_UPDATING],
  ["RESUME_UPDATE_FAILED", RESUME_UPDATE_FAILED],
  ["RESUME_RENDER_FAILED", RESUME_RENDER_FAILED],
  ["APPLIED_NONE", APPLIED_NONE],
  ["APPLIED_ONE", APPLIED_ONE],
  ["APPLIED_MANY", APPLIED_MANY],
  ["NEW_JOBS_NONE", NEW_JOBS_NONE],
  ["NEW_JOBS_ONE", NEW_JOBS_ONE],
  ["NEW_JOBS_MANY", NEW_JOBS_MANY],
  ["NEW_JOBS_CAPPED", NEW_JOBS_CAPPED],
  ["NO_SKILLS", NO_SKILLS],
  ["JOBS_UNAVAILABLE", JOBS_UNAVAILABLE],
  ...Object.entries(NUDGE_LINES).map(([k, v]) => [`NUDGE_LINES.${k}`, v] as const),
  ["ALL_SET", ALL_SET],
  ["JOBS_LIST_TAIL", JOBS_LIST_TAIL],
  ["JOBS_NONE_TAIL", JOBS_NONE_TAIL],
  ["APPLIED_LIST_TAIL", APPLIED_LIST_TAIL],
  ["FALLBACK", FALLBACK],
  // ADR-0046 Phase 1 — the router's fixed lines.
  ["V2_PHASE_OFF", V2_PHASE_OFF],
  ["V2_JOBS_DEFERRED", V2_JOBS_DEFERRED],
  ["V2_CLARIFY", V2_CLARIFY],
  ["V2_EDIT_CARD_INTRO", V2_EDIT_CARD_INTRO],
  ["V2_EDIT_NONE", V2_EDIT_NONE],
  ["V2_EDIT_IDENTITY", V2_EDIT_IDENTITY],
  ["V2_EDIT_DONE", V2_EDIT_DONE],
  ["V2_EDIT_DONE_CAPPED", V2_EDIT_DONE_CAPPED],
  ["V2_EDIT_CANCELLED", V2_EDIT_CANCELLED],
  ["V2_EDIT_STALE", V2_EDIT_STALE],
  ["V2_EDIT_UNAVAILABLE", V2_EDIT_UNAVAILABLE],
  // ADR-0046 P2 — faltu.
  ["V2_FALTU_REDIRECT", V2_FALTU_REDIRECT],
  ["V2_FALTU_COOLDOWN", V2_FALTU_COOLDOWN],
];
