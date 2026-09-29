"""The companion classifier's gold set (ADR-0046 A4) — labelled Hinglish / Hindi / English lines.

THE GATE, NOT A SUGGESTION. The acceptance criteria are >= 90% overall accuracy and >= 95%
precision on `edit_resume` (phase-1 §4). Those bars are for the REAL classifier, so this module
is the SINGLE source of truth shared by the pytest regression suite and the staging CLI
(`python -m app.companion.eval_cli --classify --base-url ...`); the suite checks the SET and the
SCORER deterministically (no model in CI), and the CLI scores a running service.

TEST DATA ONLY: every line is fabricated. No worker ever typed one, and none carries PII.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

#: The bars the real classifier must clear (phase-1 §4).
THRESHOLDS: dict[str, float] = {"accuracy": 0.90, "edit_resume_precision": 0.95}

#: Every intent a case may carry — mirrors `COMPANION_V2_INTENTS` in @badabhai/types.
INTENTS = ("edit_resume", "career_talk", "jobs_talk", "new_resume", "faltu", "unclear")


@dataclass(frozen=True)
class ClassifyScore:
    total: int
    correct: int
    accuracy: float
    edit_resume_precision: float
    misses: list[str]
    failed: list[str]


def evaluate(predict: Callable[[str], str | None]) -> ClassifyScore:
    """Score `predict` over the set. `None` (model down / schema miss) counts as `unclear`.

    PRECISION IS ONLY MEANINGFUL WITH PREDICTIONS: with no `edit_resume` prediction at all it is
    1.0 by convention, and the accuracy gate is what fails a classifier that predicts nothing.
    """
    correct = 0
    misses: list[str] = []
    tp = fp = 0
    for text, expected in CASES:
        predicted = predict(text) or "unclear"
        if predicted == expected:
            correct += 1
        else:
            misses.append(f"{text!r}: expected {expected}, got {predicted}")
        if predicted == "edit_resume":
            if expected == "edit_resume":
                tp += 1
            else:
                fp += 1
    precision = 1.0 if tp + fp == 0 else tp / (tp + fp)
    accuracy = correct / len(CASES)
    failed = []
    if accuracy < THRESHOLDS["accuracy"]:
        failed.append(f"accuracy {accuracy:.1%} < {THRESHOLDS['accuracy']:.0%}")
    if precision < THRESHOLDS["edit_resume_precision"]:
        failed.append(
            f"edit_resume precision {precision:.1%} < {THRESHOLDS['edit_resume_precision']:.0%}"
        )
    return ClassifyScore(len(CASES), correct, accuracy, precision, misses, failed)


# fmt: off
# (text, expected intent). Mixed scripts, typos and voice-transcript shapes are deliberate.
CASES: list[tuple[str, str]] = [
    # ── edit_resume (40) ──
    ("mera resume update kar do", "edit_resume"),
    ("Tata ki jagah Mahindra likho", "edit_resume"),
    ("welding bhi add karo", "edit_resume"),
    ("hindi hata do", "edit_resume"),
    ("meri salary 25000 kar do", "edit_resume"),
    ("shift night kar do", "edit_resume"),
    ("mere paas ITI certificate bhi hai, jod do", "edit_resume"),
    ("Pune mein kaam karna hai, city badal do", "edit_resume"),
    ("fitter ka kaam bhi karta hoon, add karo", "edit_resume"),
    ("mera kaam ka experience 8 saal hai, badlo", "edit_resume"),
    ("resume me kuch change karna hai", "edit_resume"),
    ("profile update", "edit_resume"),
    ("meri skills me lathe add karo", "edit_resume"),
    ("english language add kar do", "edit_resume"),
    ("salary badha do 30000", "edit_resume"),
    ("abhi kaam nahi kar raha, current job hata do", "edit_resume"),
    ("MIG welding seekha hai, skill me daalo", "edit_resume"),
    ("mera naam Ramesh hai, naam badal do", "edit_resume"),
    ("phone number update karna hai", "edit_resume"),
    ("resume se ghuma-phira ke likha hua hata do", "edit_resume"),
    ("मेरा रिज़्यूमे बदल दो", "edit_resume"),
    ("वेल्डिंग स्किल जोड़ दो", "edit_resume"),
    ("मुझे पुणे में काम करना है, शहर बदलो", "edit_resume"),
    ("मेरी सैलरी २५००० कर दो", "edit_resume"),
    ("हिंदी भाषा हटा दो", "edit_resume"),
    ("mujhe pune me kaam karna hai city change", "edit_resume"),
    ("skill add karni hai welding", "edit_resume"),
    ("resume me hindi language delete karo", "edit_resume"),
    ("update my city to nashik", "edit_resume"),
    ("change my shift to rotational", "edit_resume"),
    ("add fitter as my occupation", "edit_resume"),
    ("remove english from languages", "edit_resume"),
    ("set expected salary 28000", "edit_resume"),
    ("i have a new certificate, please add it", "edit_resume"),
    ("resume me mera purana employer galat hai, sahi karo", "edit_resume"),
    ("welding add kar do aur hindi nikal do", "edit_resume"),
    ("mera experience 5 saal likha hai, 6 saal karo", "edit_resume"),
    ("aur ek language add karo punjabi", "edit_resume"),
    ("machine operator bhi likh do skills me", "edit_resume"),
    ("resume change karna", "edit_resume"),

    # ── career_talk (26) ──
    ("welder ke baad kya seekhun", "career_talk"),
    ("career kaise banaye", "career_talk"),
    ("CNC sikhu ya welding", "career_talk"),
    ("aage kya karna chahiye", "career_talk"),
    ("kaunsi trade best hai", "career_talk"),
    ("kaise tarakki karun", "career_talk"),
    ("ITI ke baad kya kare", "career_talk"),
    ("kya main supervisor ban sakta hoon", "career_talk"),
    ("kya course karun jo accha job dilaye", "career_talk"),
    ("fitter se machinist ban sakte hain kya", "career_talk"),
    ("kaam me growth kaise hoti hai", "career_talk"),
    ("करियर कैसे बनाएं", "career_talk"),
    ("वेल्डर के बाद क्या सीखूं", "career_talk"),
    ("आगे क्या करना चाहिए", "career_talk"),
    ("how can i grow as a welder", "career_talk"),
    ("which course should i do for a better job", "career_talk"),
    ("how to become a supervisor", "career_talk"),
    ("what skills are in demand", "career_talk"),
    ("can i switch from helper to operator", "career_talk"),
    ("kaam ke saath padhai kaise karun", "career_talk"),
    ("safety ka course karna chahiye kya", "career_talk"),
    ("kaunsi company me growth hai", "career_talk"),
    ("plumber se aage kya hota hai", "career_talk"),
    ("mujhe apna skill kaise badhana chahiye", "career_talk"),
    ("salary kaise badhegi", "career_talk"),
    ("kaam ke baare me salah chahiye", "career_talk"),

    # ── jobs_talk (26) ──
    ("koi naya job hai kya", "jobs_talk"),
    ("naye jobs dikhao", "jobs_talk"),
    ("jobs chahiye", "jobs_talk"),
    ("mere area me kaam hai kya", "jobs_talk"),
    ("kisi company me vacancy hai", "jobs_talk"),
    ("kaam kahan milega", "jobs_talk"),
    ("naukri dhoondh do", "jobs_talk"),
    ("job kitne din me milegi", "jobs_talk"),
    ("meri city me job hai", "jobs_talk"),
    ("interview kab hai", "jobs_talk"),
    ("maine kitne jobs par apply kiya", "jobs_talk"),
    ("meri applications dikhao", "jobs_talk"),
    ("koi acchi job batao", "jobs_talk"),
    ("नई नौकरी है क्या", "jobs_talk"),
    ("जॉब दिखाओ", "jobs_talk"),
    ("मेरे इलाके में काम है", "jobs_talk"),
    ("कोई वैकेंसी है क्या", "jobs_talk"),
    ("any new jobs for me", "jobs_talk"),
    ("show me jobs near me", "jobs_talk"),
    ("are there vacancies in my city", "jobs_talk"),
    ("when is my interview", "jobs_talk"),
    ("how many jobs did i apply to", "jobs_talk"),
    ("find me a job", "jobs_talk"),
    ("jobs for welder in pune", "jobs_talk"),
    ("kya koi opening hai abhi", "jobs_talk"),
    ("meri applied jobs list", "jobs_talk"),

    # ── new_resume (21) ──
    ("naya resume banao", "new_resume"),
    ("resume dobara banao", "new_resume"),
    ("firse resume banao", "new_resume"),
    ("new resume chahiye", "new_resume"),
    ("resume phir se banwana hai", "new_resume"),
    ("ek aur resume banao", "new_resume"),
    ("mujhe naya resume banana hai", "new_resume"),
    ("resume regenerate karo", "new_resume"),
    ("purana resume hata kar naya banao", "new_resume"),
    ("नया रिज़्यूमे बनाओ", "new_resume"),
    ("रिज़्यूमे दोबारा बनाना है", "new_resume"),
    ("फिर से रिज़्यूमे बनाओ", "new_resume"),
    ("i want a new resume", "new_resume"),
    ("please create a new resume", "new_resume"),
    ("rebuild my resume", "new_resume"),
    ("generate my resume again", "new_resume"),
    ("make another resume for me", "new_resume"),
    ("resume naya banana hai", "new_resume"),
    ("naya resume bnana hai", "new_resume"),
    ("resum naya banao", "new_resume"),
    ("new resume please", "new_resume"),

    # ── faltu (21) ──
    ("tum pagal ho", "faltu"),
    ("bakwas band karo", "faltu"),
    ("idiot", "faltu"),
    ("yeh app faltu hai", "faltu"),
    ("tumse baat nahi karni", "faltu"),
    ("chup kar", "faltu"),
    ("gandu", "faltu"),
    ("kuch bhi mat bolo", "faltu"),
    ("tu kaam ka nahi hai", "faltu"),
    ("बकवास मत करो", "faltu"),
    ("तुम पागल हो", "faltu"),
    ("बेकार ऐप है", "faltu"),
    ("this app is useless", "faltu"),
    ("you are stupid", "faltu"),
    ("stop talking nonsense", "faltu"),
    ("shut up", "faltu"),
    ("asdfghjkl", "faltu"),
    ("😡😡", "faltu"),
    ("kkkkkk", "faltu"),
    ("hello hello hello hello", "faltu"),
    ("blah blah blah", "faltu"),

    # ── unclear (24) ──
    ("hmm", "unclear"),
    ("ok", "unclear"),
    ("haan", "unclear"),
    ("kya", "unclear"),
    ("achha", "unclear"),
    ("theek hai", "unclear"),
    ("matlab", "unclear"),
    ("pata nahi", "unclear"),
    ("sahi hai", "unclear"),
    ("haan ji", "unclear"),
    ("हम्म", "unclear"),
    ("ठीक है", "unclear"),
    ("क्या", "unclear"),
    ("हाँ", "unclear"),
    ("maybe", "unclear"),
    ("ok fine", "unclear"),
    ("i dont know", "unclear"),
    ("yes", "unclear"),
    ("no", "unclear"),
    ("hmm ok", "unclear"),
    ("kal baat karte hain", "unclear"),
    ("sochna padega", "unclear"),
    ("dekhte hain", "unclear"),
    ("phir batata hoon", "unclear"),
]
# fmt: on
