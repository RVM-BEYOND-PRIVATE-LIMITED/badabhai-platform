"""Regenerate packages/profiling-lexicon/__fixtures__/utterances.jsonl.

    cd apps/ai-service && python scripts/build_lexicon_corpus.py

THE TEXTS ARE AUTHORED BY HAND. The EXPECTED OUTPUTS are captured from the shipped Python
detectors, which are the reference implementation: Phase 3 is an extraction with NO behaviour
change, so the corpus must encode what already ships rather than what someone believes ships.
The Vitest suite in packages/profiling-lexicon then asserts against the same file, so any
divergence between the two languages turns both sides red.

That direction matters. The corpus deliberately CANNOT catch a pre-existing bug in the Python
detectors — those were established by the 314-fixture answer corpus and the existing pytest
suite. What it catches is drift: between the two languages, and between the data and either
reader.

Adding a case: append to FAMILIES, re-run, review the JSONL diff, commit both.
Every text must be unique and pseudonymized — this file is committed.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.profiling.predicates import PREDICATE_BY_NAME, classify_utterance  # noqa: E402
from app.profiling.values import VALUE_BY_NAME  # noqa: E402

OUT = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "profiling-lexicon"
    / "__fixtures__"
    / "utterances.jsonl"
)

# (id_prefix, [(text, note|None), ...])
FAMILIES: list[tuple[str, list[tuple[str, str | None]]]] = [
    # ---------------------------------------------------------------- don't know --
    ("dk", [
        ("pata nahi", None),
        ("pata nahin", None),
        ("nahi pata", None),
        ("nahin pata", None),
        ("pta nhi", None),
        ("nhi pta", None),
        ("patta nahi", None),
        ("maloom nahi", None),
        ("nahi maloom", None),
        ("malum nahin sir", None),
        ("maalum nahi bhai", None),
        ("nahi janta", None),
        ("nahi jaanta", None),
        ("nahi jaanti", None),
        ("nahi janti", None),
        ("idk", None),
        ("IDK", None),
        ("dunno", None),
        ("i don't know", None),
        ("i dont know", None),
        ("do not know", None),
        ("no idea", None),
        ("pata nahi bhai kaunsa hai", None),
        ("controller ka naam nahi pata", None),
        ("pata nahi konsa hai", None),
        ("pata nahi naam kya hai", None),
        ("नहीं पता", None),
        ("मुझे नहीं मालूम", None),
        ("pata nahi।", "danda-terminated: the boundary macro must still close the match"),
        ("idk।", "REGRESSION: treating the danda as a word character killed this match"),
    ]),
    # ------------------------------------------------- don't-know EXCLUSIONS (must NOT fire) --
    ("dkx", [
        ("nahi", "bare 'nahi' is a DENIAL, not a don't-know — never safe across all topics"),
        ("nahin", "as above"),
        ("yaad nahi", "EXCLUDED on measurement: not remembering a NAME is not not-knowing"),
        ("yad nahi", "as above"),
        ("certificate hai par naam yaad nahi", "the corpus case that got 'yaad nahi' excluded"),
        ("naam yaad nahi aa raha", "as above"),
        ("nahi chalaya", "a denial about a machine"),
        ("ITI nahi kiya", "a denial that IS a complete education answer — but not a don't-know"),
        ("setting nahi aati", "a denial that IS a complete skills answer"),
    ]),
    # ------------------------------------------------------------------- hardship --
    ("hard", [
        ("ghar chalana mushkil hai", None),
        ("ghar chalana muskil hai", None),
        ("ghar kaise chalaun", None),
        ("ghar kaise chalega", None),
        ("ghar chalana nahi ho raha", None),
        ("6 mahine se kaam nahi mila", None),
        ("3 mahine se koi kaam nahi mila", None),
        ("2 saal se naukri nahi mili", None),
        ("kaam nahi mil raha", None),
        ("kaam nhi mil raha", None),
        ("job nahi mil rahi", None),
        ("naukri nahi mili", None),
        ("kaam nahi mila", None),
        ("bahut pareshan hu", None),
        ("bahut dikkat hai", None),
        ("pareshan hoon sir", None),
        ("pareshan hai", None),
        ("guzara nahi hota", None),
        ("guzara mushkil hai", None),
        ("paise ki tangi hai", None),
        ("paise ki dikkat hai", None),
        ("paise ki kami hai", None),
        ("nikal diya", None),
        ("nikaal diya gaya", None),
        ("job chali gayi", None),
        ("naukri chhut gayi", None),
        ("kaam chhoot gaya", None),
        ("kaam nahi mil raha।", "danda-terminated"),
        ("nikal diya।", "danda after an OPTIONAL trailing group — the backtracking case"),
        ("6 mahine se kaam nahi mila, ghar chalana mushkil", None),
    ]),
    # ------------------------------------------ hardship EXCLUSIONS (must NOT fire) --
    ("hardx", [
        ("setting mushkil hoti hai par kar leta hu", "DIFFICULT WORK is a capability claim"),
        ("kaam mushkil hai lekin aata hai", "as above"),
        ("promotion mila", "an achievement must never be consoled"),
        ("supervisor bana diya", "as above"),
        ("acha kaam mil gaya", "as above"),
        ("kaam milta hai", "present tense: a statement, not distress"),
        ("mushkil", "single word — deliberately unusable on its own"),
        ("pareshani", "no person anchor"),
        ("paisa kam hai", "a salary opinion, not subsistence distress"),
    ]),
    # ---------------------------------------------------------------------- abuse --
    ("ab", [
        ("chutiya", None),
        ("chutiye", None),
        ("bhosdike", None),
        ("bhosdi", None),
        ("bhosad", None),
        ("madarchod", None),
        ("maderchod", None),
        ("behenchod", None),
        ("bhenchod", None),
        ("benchod", None),
        ("gaandu", None),
        ("gandu", None),
        ("fuck", None),
        ("fucking", None),
        ("bitch", None),
        ("asshole", None),
        ("abey chutiye sun", None),
        ("chutiya।", "danda-terminated"),
    ]),
    # --------------------------------------------- abuse EXCLUSIONS (must NOT fire) --
    ("abx", [
        ("bastard file chalata hu", "A BASTARD FILE IS A REAL TOOL — every fitter owns one"),
        ("bastard file se ghisai karta hu", "as above"),
        ("m/c chalata hu", "'m/c' is shop-floor shorthand for MACHINE, not an abbreviation slur"),
        ("mc operator hu", "as above"),
        ("bc drawing dekhta hu", "as above"),
        ("kutta nahi", "measured false positive — excluded outright"),
        ("saala bearing jam ho gaya", "'saal' = years appears in almost every experience answer"),
        ("harami machine hai", "mild/context-dependent — excluded"),
    ]),
    # --------------------------------------------------------------- question back --
    ("qb", [
        ("sir job milegi kya?", None),
        ("job milegi kya", None),
        ("job mil jayegi na?", None),
        ("kaam milega kya?", None),
        ("naukri milegi kya?", None),
        ("placement kab lagega?", None),
        ("selection ho jayega kya?", None),
        ("job kab milegi?", None),
        ("kaam mil jayega na", None),
        ("mujhe job milegi kya sir?", None),
        ("naukri mil jayegi kya", None),
        ("job lagegi kya?", None),
    ]),
    # ------------------------------------- question-back EXCLUSIONS (must NOT fire) --
    ("qbx", [
        ("abhi job kar raha hu, 1 mahina lagega",
         "MEASURED false positive: this ANSWERS availability"),
        ("job kar raha hu", "a statement"),
        ("naukri mil gayi thi", "past tense"),
        ("kaam lagega 15 din me", "an availability answer, no interrogative"),
    ]),
    # ----------------------------------------------------------------- corrections --
    ("cor", [
        ("nahi nahi 7 saal", None),
        ("nahin nahin 10 saal", None),
        ("nhi nhi 5 saal", None),
        ("nahi nhi, 8 saal", None),
        ("nai nai, teen saal", None),
        ("galat likha", None),
        ("ghalat hai", None),
        ("sorry, 12000 nahi 15000", None),
        ("correction: 5 saal", None),
        ("correct kar do", None),
        ("correct karo", "substring semantics: 'correct kar' must cover 'karo'"),
        ("correct karna hai", "as above"),
        ("actually 6 saal hai", None),
        ("asal mein 4 saal", None),
        ("asal me 20000", None),
        ("sudhar do", None),
        ("wapas se batata hu", None),
        ("नहीं नहीं 7 saal", None),
        ("गलत hai", None),
        ("nahi nahi, 7 saal — kaam milega kya?", "correction AND question-back: correction wins"),
        ("nahi bhai, 7 saal — kaam milega kya?",
         "'nahi bhai' is NOT a correction marker — only the doubled forms are, "
         "so this stays a question_back"),
        ("nahi nahi, pata nahi", "correction AND dont-know: correction wins, it carries intent"),
    ]),
    # ------------------------------------------------------- first-person claim --
    ("fp", [
        ("main welder hu", None),
        ("mai fitter hoon", None),
        ("maine 10 saal kaam kiya", None),
        ("mera kaam silai ka hai", None),
        ("meri experience 5 saal hai", None),
        ("mujhe welding aati hai", None),
        ("apna kaam karta hu", None),
        ("VMC chalata hu", None),
        ("lathe chalati hu", None),
        ("CNC chalaya hai", None),
        ("drawing padhna aata hai", None),
        ("ITI kiya hai", None),
        ("मैं वेल्डर हूँ", None),
    ]),
    # --------------------------------------- first-person claim BLOCKED (must be false) --
    ("fpx", [
        ("bhai welder hai", "THIRD PARTY: a brother's trade is not the worker's"),
        ("mere baap ka kaam tha", "third party"),
        ("papa fitter the", "third party"),
        ("pitaji ne kiya tha", "third party"),
        ("chacha ka workshop hai", "third party"),
        ("dost welder hai", "third party"),
        ("mera friend CNC chalata hai", "third party — blocker wins over the first-person marker"),
        ("pati driver hai", "third party"),
        ("husband ka kaam hai", "third party"),
        ("patni silai karti hai", "third party"),
        ("biwi ka kaam hai", "third party"),
        ("wife tailor hai", "third party"),
        ("main welder banna chahta hu", "ASPIRATION: wanting to become is not being"),
        ("mai CNC chahta hu", "aspiration"),
        ("welder banna hai", "aspiration"),
        ("CNC seekh raha hu", "TRAINING: carries a first-person marker and is NOT a claim"),
        ("training kar raha hu", "training"),
        ("humare yahan CNC hai", "TD101: describes the WORKPLACE, no first-person marker at all"),
        ("factory me VMC lagi hai", "describes the workplace"),
    ]),
    # ---------------------------------------------------------------- empty/short --
    ("emp", [
        ("", None),
        (" ", None),
        ("  ", None),
        ("\n", None),
        (".", None),
        ("..", None),
        ("...", None),
        ("?", None),
        ("!", None),
        ("।", "a lone danda is a Hindi full stop — the worker has said nothing"),
        ("।।", None),
        ("-", None),
        ("—", None),
        ("a", "single character"),
        ("h", None),
        ("(", None),
        ("[]", None),
        ("/", None),
    ]),
    # -------------------------------------------------------- ordinary answers --
    ("ans", [
        ("7 saal se silai kar raha hoon", None),
        ("10 saal ka experience hai", None),
        ("VMC operator hu", None),
        ("lathe machine chalata hu", None),
        ("welding karta hu", None),
        ("fitter ka kaam", None),
        ("kharad ka kaam karta hun", None),
        ("silai ka kaam karta hoon, export line pe", None),
        ("dilli", None),
        ("15000 mahina", None),
        ("pandrah hazaar chahiye", None),
        ("18k expected", None),
        ("2.5 lakh saal ka", None),
        ("abhi free hu", None),
        ("15 din ka notice hai", None),
        ("kahin bhi ja sakta hu", None),
        ("ITI kiya hai NCVT se", None),
        ("diploma hai mechanical me", None),
        ("fanuc controller chalaya hai", None),
        ("siemens pe kaam kiya", None),
        ("tool offset setting karta hu", None),
        ("g-code edit kar leta hu", None),
        ("gd&t aata hai", None),
        ("mastercam use kiya hai", None),
        ("fixture setup karta hu", None),
        ("drawing padh leta hu", None),
        ("part no. 12 wala kaam",
         "'no.' is the ABBREVIATION — must not negate the words before it"),
        ("drawing no. 45 dekha tha", "as above: 'drawing' must survive"),
        ("मैं दिल्ली में रहता हूँ", None),
        ("वेल्डिंग का काम करता हूँ", None),
        ("५ साल का अनुभव", None),
        ("नौकरी चाहिए", None),
        ("haan ji", None),
        ("theek hai", None),
        ("ok", None),
        ("ji", None),
        ("bataiye", None),
        ("kya batau", None),
    ]),
    # ---------------------------------------------------------------- negation --
    ("neg", [
        ("abhi kaam nahi mil raha", "MUST NOT become availability=immediate"),
        ("VMC nahi chalaya", "a denial — the engine must still ask the machines question"),
        ("setting nahi aati, sirf chalata hu",
         "clause split: the denial must not swallow 'chalata hu'"),
        ("VMC chalata hu na", "clause-final 'na' is an AFFIRMATIVE tag, not a denial"),
        ("haan na", "tag position"),
        ("theek hai na", "tag position"),
        ("na bhai aisa nahi hai", "'na' followed by more words IS a negator"),
        ("diploma nahi hai", None),
        ("certificate nahi hai", None),
        ("ncvt nahi hai", None),
        ("drawing nahi aati", None),
        ("program editing nahi aata", None),
        ("g code nahi aata", None),
        ("fixture nahi lagaya", None),
        ("mastercam nahi chalaya", None),
        ("kabhi nahin kiya", None),
        ("mat karo", None),
        ("never done", None),
        ("नहीं किया", None),
        ("नही आता", None),
        ("मत भेजो", None),
        ("relocate nahi karunga", None),
        ("bahar nahi jaunga", None),
        ("shift nahi kar sakta", None),
    ]),
    # ------------------------------------------------ Devanagari script coverage --
    ("dev", [
        ("मैं फिटर हूँ", None),
        ("वीएमसी चलाता हूँ", None),
        ("खराद का काम करता हूँ", None),
        ("सिलाई का काम", None),
        ("दस साल का अनुभव", None),
        ("पंद्रह हजार चाहिए", None),
        ("दिल्ली में रहता हूँ", None),
        ("बिहार से हूँ", None),
        ("आईटीआई किया है", None),
        ("नहीं आता", None),
        ("मुझे नहीं पता", None),
        ("पता नहीं भाई", None),
        ("घर चलाना मुश्किल है",
         "Devanagari hardship — the cue list is Latin-only, so this must NOT fire"),
        ("काम नहीं मिल रहा",
         "as above: a KNOWN gap, pinned so widening the cue list is a visible diff"),
        ("मैं वेल्डर बनना चाहता हूँ",
         "aspiration in Devanagari — blockers are Latin-only, also a known gap"),
        ("ठीक है", None),
        ("हाँ जी", None),
        ("क्या करूँ", None),
        ("मशीन चलाई है", None),
        ("ड्राइंग पढ़ लेता हूँ", None),
        ("नहीं नहीं, सात साल", "Devanagari correction marker IS in the list"),
        ("गलत लिखा है", "Devanagari correction marker"),
        ("मत भेजो वहाँ", None),
        ("५ साल", None),
        ("१५००० महीना", None),
    ]),
    # ------------------------------------------------- danda / punctuation tails --
    ("danda", [
        ("nahi pata bhai।", None),
        ("maloom nahi।", None),
        ("dunno।", None),
        ("no idea।", None),
        ("ghar chalana mushkil hai।", None),
        ("pareshan hoon।", None),
        ("naukri chali gayi।", None),
        ("bhosdike।", None),
        ("fucking।", None),
        ("galat।", None),
        ("job milegi kya?।", None),
        ("main welder hu।", None),
        ("VMC chalata hu।", None),
        ("pata nahi...", "ellipsis tail"),
        ("pata nahi!!", None),
        ("idk?", None),
        ("kaam nahi mil raha!", None),
    ]),
    # ------------------------------------------------ negation engine, extended --
    ("neg2", [
        ("welding nahi aati", None),
        ("cnc nahi chalaya kabhi", None),
        ("fanuc nahi dekha", None),
        ("siemens nahi aata", None),
        ("gd&t nahi padh sakta", None),
        ("tool offset nahi karta", None),
        ("m code nahi aata", None),
        ("degree nahi hai", None),
        ("engineering nahi ki", None),
        ("nsdc nahi kiya", None),
        ("apprentice nahi tha", None),
        ("certification nahi hai", None),
        ("nsqf nahi hai", None),
        ("scvt nahi", None),
        ("setting aati hai na", "tag-position 'na' after a verb — affirmative, not a denial"),
        ("kaam karta hu na", "tag position"),
        ("sahi na", "tag position"),
        ("ok na", "tag position"),
        ("na na aisa nahi", "leading 'na' with following words IS a negator"),
        ("mat bhejo mujhe", None),
        ("never worked on that", None),
        ("not done", None),
        ("kabhi nahi kiya", None),
        ("bilkul nahi", None),
    ]),
    # ------------------------------------------------------ more ordinary answers --
    ("ans2", [
        ("turner hu", None),
        ("grinder chalata hu", None),
        ("press operator ka kaam", None),
        ("helper tha pehle", None),
        ("supervisor hu abhi", None),
        ("quality inspection karta hu", None),
        ("assembly line pe tha", None),
        ("painting ka kaam", None),
        ("electrician hu", None),
        ("plumber ka kaam karta hu", None),
        ("carpenter hu", None),
        ("mason ka kaam", None),
        ("driver hu, LMV license hai", None),
        ("security guard tha", None),
        ("cook ka kaam kiya hai", None),
        ("housekeeping me tha", None),
        ("Mumbai me kaam kiya", None),
        ("Pune shift ho sakta hu", None),
        ("Gurgaon me hu abhi", None),
        ("Noida sector 63", None),
        ("25000 mil raha tha", None),
        ("30 hazar chahiye", None),
        ("1 mahine ka notice", None),
        ("abhi join kar sakta hu", None),
    ]),
    # ------------------------------------------------------------ cities / states --
    ("loc", [
        ("main pune me rehta hu", None),
        ("pune", None),
        ("dilli se hu", "alias resolves INTO the closed canonical set"),
        ("dilly me kaam kiya", "alias + misspelling"),
        ("bombay me tha", "alias -> Mumbai"),
        ("calcutta", "alias -> Kolkata"),
        ("poona", "alias -> Pune"),
        ("banglore me job", "misspelling alias"),
        ("BANGALORE", "uppercase"),
        ("gudgaon me rehta hu", "misspelling -> Gurugram"),
        ("new delhi me hu", "LONGEST-FIRST: must not match the 'delhi' inside 'new delhi'"),
        ("navi mumbai", "longest-first again"),
        ("greater noida me kaam", "longest-first again"),
        ("manesar plant me tha", None),
        ("pithampur", None),
        ("hosur me kaam kiya", None),
        ("bihar mai hu", None),
        ("uttar pradesh se hu", None),
        ("tamil nadu", None),
        ("UP se hu", "UPPERCASE abbreviation IS a state"),
        ("MP me ghar hai", "uppercase abbreviation"),
        ("machine set up kiya",
         "lowercase 'up' must NOT become Uttar Pradesh — the whole reason "
         "abbrevs are case-sensitive"),
        ("setup karta hu", "as above"),
        ("delhi ncr me kaam", "region AND city both present"),
        ("south india me kaam kiya", None),
        ("north india", None),
        ("south side me rehta hu", "'south' alone is NOT a region cue"),
        ("made in india", "'india' alone is NOT a region cue"),
        ("pune nahi jaunga", "NEGATED: the city is detected but vetoed"),
        ("delhi nahi", "negated"),
    ]),
    # -------------------------------------------------------------- experience --
    ("exp", [
        ("7 saal ka experience", None),
        ("10 years", None),
        ("12 yrs kaam kiya", None),
        ("3 yr", None),
        ("ek saal", None),
        ("do saal", None),
        ("teen saal se", None),
        ("chaar saal", None),
        ("paanch saal", None),
        ("chhe saal", None),
        ("saat saal", None),
        ("aath saal", None),
        ("nau saal", None),
        ("das saal ka tajurba hai", None),
        ("gyarah saal", None),
        ("barah saal", None),
        ("pandrah saal", None),
        ("bees saal", None),
        ("dedh saal", "1.5 — compound"),
        ("derh saal", "1.5 — spelling variant"),
        ("dhaai saal", "2.5"),
        ("adhai saal", "2.5 — spelling variant"),
        ("aadha saal", "0.5"),
        ("paune do saal", "1.75 — LONGEST-FIRST: must not read as 'paune' (0.75)"),
        ("sava do saal", "2.25 — must not read as 'sava' (1.25)"),
        ("paune saal", "0.75 — the short form alone"),
        ("sava saal", "1.25 — the short form alone"),
        ("7-8 saal",
         "MEASURED: yields 8, not 7 — only the number ADJACENT to the unit "
         "qualifies, so a range records the optimistic end. Shipped behaviour, "
         "pinned deliberately"),
        ("7 se 8 saal", "same as above with a word separator"),
        ("5+ years", None),
        ("12.5 saal", "decimal"),
        ("7 saal nahi", "NEGATED: value found but vetoed"),
        ("koi experience nahi", "no quantity at all"),
        ("7 mahine", "months are not years — must NOT match"),
        ("part no 7 dekha", "a bare number with no unit must NOT match"),
    ]),
    # ------------------------------------------------------ salary: monthly forms --
    ("sal", [
        ("22000 milta hai", "plain monthly, no unit"),
        ("salary 28000 hai", None),
        ("20k mahina milta hai", "k unit + explicit monthly cue"),
        ("25 hazaar per month",
         "MEASURED GAP, records NOTHING: the unit list has 'hazar' but not the very common "
         "'hazaar' spelling, so this is a bare 2-digit number and is dropped. Pinned so "
         "adding the spelling is a visible one-line diff with a corpus change attached"),
        ("24 thousand milta hai", None),
        ("2 hzr", "the abbreviated thousand unit"),
        ("rs 32000 chahiye", "EXPECTED slot: 'chahiye' near the amount"),
        ("₹ 27000 milta hai", "rupee sign is a money cue"),
        ("INR 24000 monthly", None),
        ("tankha 26000 hai", None),
        ("pagar 19000", None),
        ("40000 pm", "'pm' is a monthly cue"),
        ("35000 p.m. chahiye", "monthly cue with dots + an expectation cue"),
        ("1.5 lakh mahina", "decimal lakh, explicitly monthly"),
        ("28000 kamata hu", None),
        ("stipend 9000 milta hai", None),
        ("28000 nahi milta", "NEGATED: the amount is found and vetoed, not dropped"),
    ]),
    # ------------------------------------------------- salary: the 12x period cases --
    ("salp", [
        ("3 lakh saalana milta hai", "annual cue BEFORE the amount"),
        ("4 lakh per annum chahiye",
         "MEASURED: annual (33,333/month) but the CURRENT slot, not expected. The "
         "expectation window is 10 chars past the match end and 'chahiye' sits at 17, so "
         "the cue is out of reach. The narrow window is what stops a neighbouring answer's "
         "cue from stealing this amount"),
        ("360000 per year milta hai", "annual, no unit word"),
        ("3.6 lakh yearly", None),
        ("5 lakh varsh ka", None),
        ("4.2 lakh p.a.", "the abbreviated annual cue"),
        ("6 saal se 28000 milta hai",
         "THE ASYMMETRY CASE: a bare 'saal' BEFORE the amount is the EXPERIENCE clause, "
         "not an annual marker. Reading it as annual divides a correct wage by twelve"),
        ("5 lakh saal ka mahina",
         "AMBIGUOUS: an annual AND a monthly cue — records NOTHING, per prefer-no-number"),
        ("ctc 5 lakh",
         "PINNED SHIPPED BUG: 'ctc' is a money cue but NOT an annual one, so this records "
         "₹5,00,000 per MONTH. CTC is annual in ordinary usage. Changing it is a product "
         "call, not a port — the corpus pins today's answer so the change is visible"),
        ("6 lpa",
         "PINNED: records NOTHING. A bare 1-2 digit number with no unit is dropped before "
         "the period is ever consulted, so the 'lpa' annual cue never gets to speak"),
    ]),
    # --------------------------------------- salary EXCLUSIONS (must record nothing) --
    ("salx", [
        ("2015 se kaam kar raha hu", "a START YEAR, not a wage"),
        ("2015 rupaye milte hai",
         "the same 4-digit number WITH a money cue IS money — that is the whole test"),
        ("1998 batch ka hu", "calendar year"),
        ("roll number 987654 hai", "a credential id, not a wage"),
        ("certificate no 3345 hai", "credential id"),
        ("licence number 7781", "credential id"),
        ("NCVT hai aur 26000 milta hai",
         "the credential cue is NOT adjacent to the digits, so the wage survives — the "
         "false-suppression regression a line scan shipped"),
        ("NSQF level 5 kiya hai",
         "the bare 'k'/'l' unit must not match the first letter of the next word"),
        ("level 4 kaam karta hu", "as above — '4 k' from 'kaam' would record ₹4,000"),
        ("800 rupaye roz", "below the ₹1,000 floor"),
        ("950 milta hai", "below the floor"),
        ("200 lakh chahiye", "₹2,00,00,000 is over the plausibility ceiling"),
        ("5 crore", "'crore' is not a unit this matcher knows"),
    ]),
    # --------------------------------------------- salary: both slots, lines, script --
    ("sal2", [
        ("abhi 21000 milta hai, 31000 chahiye",
         "one message filling BOTH slots — the current-vs-expected split"),
        ("29000 milta hai\n39000 chahiye",
         "LINE CLAMP: without it the second line's cue marks the first line's amount "
         "as expected, and the real expected figure is then dropped as a duplicate"),
        ("4 lakh\nsaal ka",
         "the clamp again, on the PERIOD cue: 'saal' on the next line must not make "
         "this annual"),
        ("२८००० मिलता है",
         "Devanagari digits — Python's \\d already matched them and float() parses "
         "them, so [0-9०-९] is what preserves the shipped answer"),
        ("23000 milta hai par 33000 chahiye aur ITI bhi kiya hai",
         "a long multi-answer turn: both slots plus unrelated trailing content"),
    ]),
    # ---------------------------------------------------------- availability: immediate --
    ("av", [
        ("immediate join kar sakta hu", "STRONG cue, no blocker needed"),
        ("turant aa sakta hu", None),
        ("fauran join kar lunga", None),
        ("ready to join hu", None),
        ("abhi join kar sakta hun",
         "time adverb NEXT TO a join intent — the only way 'abhi' can count"),
        ("kal se start kar sakta hu", None),
        ("aaj hi joining kar sakta hu", None),
        ("main free hu abhi", "self-state, first person"),
        ("khaali hu", None),
        ("berozgar hu bhai", None),
        ("main available hu", None),
        ("naukri chhod di", None),
        ("kaam nahi kar raha", "NEGATION-BEARING: the negator is what makes it mean available"),
        ("job nahi kar raha filhal", "negation-bearing"),
    ]),
    # ------------------------------------- availability EXCLUSIONS (must NOT fire) --
    ("avx", [
        ("abhi pune me hu",
         "THE FABRICATION THIS FIX EXISTS FOR: our own question opens with 'abhi', so the "
         "natural answer used to invent availability: immediate"),
        ("abhi 25000 milte hain", "as above, on the salary question"),
        ("job abhi ready hai",
         "on a shop floor 'job' is the WORKPIECE — bare `ready` was removed for exactly this"),
        ("machine free hai", "an OBJECT, not the worker — third-person copula"),
        ("tool aaj ready ho jayega", "an object"),
        ("mera bhai berozgar hai", "a THIRD PARTY's unemployment"),
        ("wo free hai", "third party"),
        ("sunday free hu", "TIME-SCOPED: free at a time is not free for a job"),
        ("lunch me free hu", "time-scoped"),
        ("pichli job chhod di thi", "PAST — the tense blocker"),
        ("koi job available hai kya?",
         "a question about VACANCIES, not a start date — the trailing lookahead"),
        ("freelance kaam karta hu", "the 'free' substring must not fire a first-person cue"),
        ("6 month ka experience hai", "used to record notice_period"),
        ("kal meri shaadi hai to ready rahunga",
         "anchored at BOTH ends: a long sentence opening with a time word is not a start date"),
    ]),
    # ------------------------------------------ availability: negated (#441 B) --
    ("avn", [
        ("abhi available nahi hu", "used to record availability: immediate"),
        ("turant join nahi kar sakta", "used to record immediate"),
        ("abhi khaali nahi hu", "used to record immediate"),
        ("turant nahi aa sakta",
         "PRE-POSED negator: negated ability puts the negator FIRST, which the backward "
         "mask alone does not cover"),
        ("abhi nahi join kar sakta", "pre-posed negator"),
        ("kaam nahi kar raha, turant join kar sakta hu",
         "CLAUSE-CLAMPED: a negator in the previous clause must not suppress this answer"),
        ("kaam nahi milta isliye turant join kar sakta hu",
         "the negator is three tokens back — outside the 2-token lookback, so the cue survives"),
    ]),
    # ------------------------------------------------------------- notice period --
    ("nt", [
        ("notice period hai", None),
        ("resign kar diya hai", None),
        ("next month join karunga", None),
        ("15 din lagenge", "a duration that is the time something TAKES"),
        ("30 din baad aa sakta hu", None),
        ("ek mahina lagega", "word number -> 30 days"),
        ("do mahine lagenge", "-> 60 days"),
        ("ek hafta lagega", "-> 7 days"),
        ("pandrah din lagega", "word number -> 15"),
        ("lagega 20 din", "the reversed word order"),
        ("2 weeks baad aa jaunga", None),
    ]),
    # ------------------------------------------ notice EXCLUSIONS (must NOT fire) --
    ("ntx", [
        ("10 din pehle join kiya tha", "time AGO, not time until"),
        ("hafte me 6 din kaam karta hu", "a work WEEK, not a notice"),
        ("do mahine se salary nahi mili", "time SINCE — 'X se' is 'for the last X'"),
        ("5 saal ka tajurba", "years are EXPERIENCE, never a notice period"),
        ("notice period nahi hai", "a DENIAL of a notice period"),
        ("15 din nahi lagenge", "a denial"),
    ]),
    # ------------------------------------------------------------- relocation --
    ("rl", [
        ("kahin bhi jaa sakta hu", "generality of place — a complete flexibility answer"),
        ("kahi bhi bhej do", None),
        ("koi bhi sheher chalega", "a PLACE the worker accepts"),
        ("bahar ja sakta hu", "a PLACE next to a GO verb"),
        ("dusre sheher shift ho sakta hu", None),
        ("relocate kar sakta hu", "explicit and unambiguous in English"),
        ("transfer le sakta hu", None),
        ("bahar jaane ko taiyaar hu", "READY attached to a MOVE"),
        ("shift hone ko taiyaar hu", None),
        ("out of station chalega", None),
        ("कहीं भी जा सकता हूँ",
         "Devanagari generality-of-place — uses the {DB}/{DE} block boundary, because a word "
         "boundary does not work after a matra and would make this silently dead"),
    ]),
    # ---------------------------------------- relocation EXCLUSIONS (must NOT fire) --
    ("rlx", [
        ("bahar ka diameter 40 hai",
         "'bahar KA diameter' is the outer diameter — only the verb beside it decides"),
        ("night shift karta hu", "'shift' must take a becoming-form"),
        ("general shift me hu", "as above"),
        ("vmc chalega mujhe", "'chalega' alone is the MACHINE verb"),
        ("ready hu machine ke liye",
         "'ready' with no MOVE to attach to, so relocation stays unset. It DOES record "
         "availability: immediate — the self-state blockers look for an object BEFORE "
         "the cue, and here 'machine' follows it. Shipped behaviour, pinned"),
        ("dusre sheher me kaam kiya tha", "work HISTORY, not an intention"),
        ("bahar nahi jaaunga", "NEGATED"),
        ("relocate nahi kar paunga", "negated"),
    ]),
]


def _values_for(text: str) -> dict[str, object]:
    """Expected normalizer output.

    A key is present ONLY when the normalizer returns something, so an absent key means "must
    return null" — that is the assertion, and it is the one that catches a detector which starts
    firing where it should not. `negationVetoed` travels with the value because a vetoed match is
    a DIFFERENT outcome from no match: the cue was seen and deliberately not counted.
    """
    out: dict[str, object] = {}
    for name, fn in VALUE_BY_NAME.items():
        found = fn(text)
        if found is None:
            continue
        out[name] = {
            "value": found.value,
            "span": [found.span.start, found.span.end],
            "negationVetoed": found.negation_vetoed,
        }
    return out


def main() -> None:
    seen_text: dict[str, str] = {}
    lines: list[str] = []
    for prefix, cases in FAMILIES:
        for index, (text, note) in enumerate(cases, start=1):
            case_id = f"{prefix}_{index:03d}"
            if text in seen_text:
                raise SystemExit(
                    f"duplicate fixture text {text!r}: {seen_text[text]} and {case_id}"
                )
            seen_text[text] = case_id

            record: dict[str, object] = {
                "id": case_id,
                "text": text,
                "cls": classify_utterance(text).cls,
                "predicates": {name: fn(text) for name, fn in PREDICATE_BY_NAME.items()},
                "values": _values_for(text),
            }
            if note:
                record["note"] = note
            lines.append(json.dumps(record, ensure_ascii=False, sort_keys=False))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    # newline="\n" explicitly: text mode translates to os.linesep, so on Windows this file
    # regenerates with CRLF. Git normalizes it away on commit today, which is exactly what makes
    # the hazard easy to miss — turn that normalization off and the whole corpus reads as changed.
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {len(lines)} cases -> {OUT}")

    rows = [json.loads(line) for line in lines]
    print("class distribution:", dict(Counter(r["cls"] for r in rows)))
    print("cases carrying a value:", sum(1 for r in rows if r["values"]))
    print("negation-vetoed values:",
          sum(1 for r in rows for v in r["values"].values() if v["negationVetoed"]))


if __name__ == "__main__":
    main()
