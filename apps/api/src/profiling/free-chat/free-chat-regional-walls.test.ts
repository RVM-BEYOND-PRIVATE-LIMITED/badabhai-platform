import { describe, expect, it } from "vitest";

import { screenFreeChatAnswer } from "./free-chat-output.validator";
import {
  ENGLISH_JUDGEMENT_WORDS,
  ENGLISH_PROMISE_TOKENS,
  ENGLISH_RATING_FILLERS,
  ENGLISH_RESPECTFUL_YOU,
  ENGLISH_SENSITIVE_WORDS,
  ENGLISH_SURELY_WORDS,
  ENGLISH_WILL_GET_WORDS,
  regionalPromise,
  REGIONAL_JUDGEMENT_WORDS,
  REGIONAL_PERSONA_TOKENS,
  REGIONAL_PROMISE_TOKENS,
  REGIONAL_RESPECTFUL_YOU,
  REGIONAL_SENSITIVE_WORDS,
  REGIONAL_SURELY_WORDS,
  REGIONAL_WILL_GET_WORDS,
  regionalWallFailure,
  SOFT_PROMISE_CONDITIONS,
  SOFT_PROMISE_DISCLAIMER_BREAKS,
  SOFT_PROMISE_DISCLAIMERS,
  SOFT_PROMISE_FILLERS,
  SOFT_PROMISE_IF_WORDS,
  SOFT_PROMISE_JOB_WORDS,
  SOFT_PROMISE_NEW_STATEMENT,
  SOFT_PROMISE_QUESTION_WORDS,
  SOFT_PROMISE_TAKE_BACKS,
  SOFT_PROMISE_THEN_WORDS,
  SOFT_PROMISE_WILL_GET_PHRASES,
} from "./free-chat-regional-walls";

/**
 * ADR-0051 §9 (#2126): a reply in Marathi, Gujarati, Kannada, Telugu or Tamil mixed with English
 * (Latin letters, the way Hinglish mixes Hindi and English) meets the same persona, promise,
 * sensitive-advice and rating bar as a Hinglish one — in its own words.
 */

const answer = (lines: string[], followup_chips: string[] = []) => ({ lines, followup_chips });
const failure = (lines: string[], chips: string[] = []) => {
  const out = screenFreeChatAnswer(answer(lines, chips));
  return out.kind === "reject" ? out.failure : null;
};

describe("good regional replies are served", () => {
  it.each([
    ["Tamil", "Welding nalla skill, neenga safety training eduthaa growth irukku."],
    ["Telugu", "Meeru CNC nerchukunte factory lo manchi demand undi."],
    ["Kannada", "Neevu ITI certificate tagondre fitter kelasakke help aagutte."],
    ["Marathi", "Tumhi welding shikla tar Pune madhe kaam milnyachi shakyata aahe."],
    ["Gujarati", "Tame electrician no course karsho to kaam ma madad thase."],
    ["a Hinglish reply, unchanged", "Welding seekhna har factory mein kaam aata hai."],
  ])("%s: %j", (_language, line) => {
    expect(failure([line])).toBeNull();
  });

  it("'kandippa' alone is advice, not a promise — as 'zaroor try kijiye' is", () => {
    expect(failure(["Kandippa try pannunga, practice mukkiyam."])).toBeNull();
  });
});

describe("each wall, in the regional words", () => {
  it.each([
    ["Tamil familiar address", "Thambi, welding seekhunga.", "persona"],
    ["Tamil informal you", "Nee welding padikkalaam.", "persona"],
    ["Telugu informal you", "Nuvvu CNC nerchuko.", "persona"],
    ["Kannada familiar address", "Maga, ITI maadu.", "persona"],
    ["Marathi informal you", "Tula kaam milel.", "persona"],
    ["Gujarati informal you", "Tane kaam madse.", "persona"],
    ["Gujarati pakka", "Kaam pakku madse.", "promise"],
    ["Tamil will-surely-get", "Velai kandippa kidaikkum.", "promise"],
    ["Telugu will-surely-get", "Job khachitanga vastundi.", "promise"],
    ["Kannada will-surely-get", "Kelasa khanditavagi sigutte.", "promise"],
    ["Marathi will-surely-get", "Naukri nakki milel.", "promise"],
    ["Gujarati will-surely-get", "Nokri chokkas malse.", "promise"],
    ["Tamil medicine", "Indha marundhu saapdunga.", "sensitive_advice"],
    ["Telugu loan", "Bank nunchi appu teesukondi.", "sensitive_advice"],
    ["Kannada court", "Nyayalaya ge hogi.", "sensitive_advice"],
    ["Marathi loan", "Karj ghya.", "sensitive_advice"],
    ["Gujarati medicine", "Aa dava lo.", "sensitive_advice"],
    ["Tamil rating", "Neenga nalla worker.", "worker_rating"],
    ["Telugu rating", "Meeru best.", "worker_rating"],
    ["Marathi rating", "Tumhi kamjor aahat.", "worker_rating"],
    ["Gujarati rating", "Tame saara chho.", "worker_rating"],
  ])("%s: %j → %s", (_what, line, expected) => {
    expect(failure([line])).toBe(expected);
  });

  it("a chip carrying a regional word rejects the whole answer, even one the length rule drops", () => {
    expect(failure(["Welding seekhiye."], ["machan tips"])).toBe("persona");
    expect(failure(["Welding seekhiye."], ["kandippa velai kidaikkum ithu nichayam"])).toBe(
      "promise",
    );
  });

  it("matches whole words, case- and accent-insensitively", () => {
    expect(regionalWallFailure("ANNA")).toBe("persona");
    expect(regionalWallFailure("Ánna")).toBe("persona");
    // "annual" and "tamed" carry a listed word inside them; neither is the word.
    expect(regionalWallFailure("annual training")).toBeNull();
    expect(regionalWallFailure("tamed")).toBeNull();
  });

  it("a rating needs the respectful 'you' DIRECTLY before the judgement word", () => {
    expect(regionalWallFailure("neenga nalla")).toBe("worker_rating");
    expect(regionalWallFailure("nalla skill, neenga practice pannunga")).toBeNull();
  });
});

/**
 * ADR-0051 §11 (R40, #2181): English in, English out — so a plain-English reply meets the same
 * promise (R11) and rating (R17) bar, in English words. Before these lists the gate SERVED every
 * line in the first table.
 */
describe("the English walls (§11)", () => {
  it.each([
    ["the review's promise", "You will definitely get a job after this course.", "promise"],
    ["the review's raise", "Your salary will definitely go up after this course.", "promise"],
    ["surely + be hired", "You will surely be hired by a good factory.", "promise"],
    ["certainly + get", "With this certificate you will certainly get work.", "promise"],
    ["guaranteed, and a pair", "A job is guaranteed, you will get it soon.", "promise"],
    ["for sure", "You will get a job for sure.", "promise"],
    ["100 percent", "100 percent you will get a job.", "promise"],
    ["a contraction", "You'll definitely get a job.", "promise"],
    // Re-review: "guaranteed" / "guarantees" stand alone, as "pakka" does.
    ["guaranteed alone", "A job is guaranteed after this course.", "promise"],
    ["you are guaranteed", "You are guaranteed a job after this course.", "promise"],
    ["guarantees", "This course guarantees a job.", "promise"],
    ["guaranteed in Hinglish", "Job guaranteed hai is course ke baad.", "promise"],
    // Re-review: the missing will-get verbs.
    ["surely + be selected", "You will surely be selected in the next batch.", "promise"],
    ["definitely + increase", "Your salary will definitely increase with this course.", "promise"],
    ["definitely + land", "You will definitely land a job in a big factory.", "promise"],
    ["100 percent + are sure to get", "100 percent you are sure to get a job.", "promise"],
    // "sure to get" after is / are / you're stands alone, as "guaranteed" does.
    ["you are sure to get", "You are sure to get a job after this course.", "promise"],
    ["you're sure to get", "You're sure to get a job.", "promise"],
    ["he is sure to get", "He is sure to get selected.", "promise"],
    ["is sure to get", "Your salary is sure to get a raise.", "promise"],
    ["are sure to get", "Workers like you are sure to get work here.", "promise"],
    // Owner ruling 2026-10-13 (#2227): English medical, legal and money advice.
    [
      "the owner's painkiller line",
      "Take a painkiller tablet twice a day for back pain.",
      "sensitive_advice",
    ],
    [
      "the owner's medicine line",
      "Please take the medicine your doctor gives, two times a day.",
      "sensitive_advice",
    ],
    ["a dose", "Check the dosage on the box before each dose.", "sensitive_advice"],
    ["an injection", "An injection helps with this pain.", "sensitive_advice"],
    ["loan advice", "Take loans from the bank to buy your tools.", "sensitive_advice"],
    ["court advice", "Go to court with your salary slips.", "sensitive_advice"],
    ["insurance advice", "Buy insurance for your bike first.", "sensitive_advice"],
    ["an EMI", "Pay the EMI on time every month.", "sensitive_advice"],
    ["investments", "Put your savings in investments.", "sensitive_advice"],
    ["lawyers", "Talk to lawyers about your case.", "sensitive_advice"],
    // Re-review: a clause that is only a surely word still pairs with its neighbour.
    ["a surely clause before", "Definitely, you will get a job.", "promise"],
    ["a surely clause after", "You will get a job, for sure.", "promise"],
    ["a comma inside a number", "Definitely you will get 15,000 a month here.", "promise"],
    ["the review's rating", "You are the best welder here.", "worker_rating"],
    ["the review's weakness", "You are weak in drawing, so practise more.", "worker_rating"],
    ["you're + best", "You're the best in this workshop.", "worker_rating"],
    ["worst", "You are the worst at measuring.", "worker_rating"],
    ["very + weak", "You are very weak in maths.", "worker_rating"],
    ["a + great", "You are a great welder.", "worker_rating"],
    ["perfect", "You are perfect for this job.", "worker_rating"],
    ["excellent", "You are excellent at fitting.", "worker_rating"],
    ["top", "You are the top worker in the team.", "worker_rating"],
    ["number one", "You are number one in this trade.", "worker_rating"],
    // Re-review: good and bad, as every regional list has them.
    ["very + good", "You are very good at welding.", "worker_rating"],
    ["good", "You are good at fitting.", "worker_rating"],
    ["bad", "You are bad at measuring.", "worker_rating"],
    ["not + good", "You are not good at drawing.", "worker_rating"],
    ["poor", "You're poor at reading drawings.", "worker_rating"],
  ])("%s: %j → %s", (_what, line, expected) => {
    expect(failure([line])).toBe(expected);
    expect(regionalWallFailure(line)).toBe(expected);
  });

  it.each([
    ["a surely word alone is advice", "You can definitely try an ITI course."],
    ["plain advice", "Practise every day."],
    ["'you are' before a non-judgement word", "You are learning fast."],
    ["'you are' with a word between", "You are in a good trade."],
    ["'will get' without a surely word", "You will get practice at a workshop."],
    ["a surely word without a will-get phrase", "Certainly, safety shoes help on site."],
    ["'best' praising the work", "The best way to learn welding is daily practice."],
    // Re-review: "in" is not a filler, and the prompt's own praise of the skill is served.
    ["'good' after 'in'", "You are in a good trade."],
    ["praise of the skill", "This skill is useful, keep practising."],
    // Re-review: "will find" is directions, and "make sure to get" is advice.
    ["'will find' is not a will-get verb", "You will definitely find the form on the ITI site."],
    ["'make sure to get' is advice", "Make sure to get your safety shoes."],
    ["'make sure to get' with a surely word", "Definitely make sure to get your ITI certificate."],
    // Owner ruling 2026-10-13: "doctor" stays allowed (TD147(2)), and so does safety advice.
    ["see a doctor", "Please see a doctor."],
    ["doctor in Hinglish", "Safety ke liye doctor se check karwaiye."],
    ["safety shoes", "Wear safety shoes at work."],
    ["the supervisor", "Ask the supervisor."],
    ["'tablet' inside a word", "Use a stable ladder and keep the floor dry."],
    // Re-review: a pair must sit inside one clause.
    ["a rating across a comma", "Please tell me where you are, the best ITI may be near."],
    ["a promise across a comma", "Definitely ask the supervisor, you will get a clear answer."],
    ["a promise across a full stop", "Ask definitely. You will get an answer from them."],
  ])("%s: %j is served", (_what, line) => {
    expect(failure([line])).toBeNull();
    expect(regionalWallFailure(line)).toBeNull();
  });

  it("a chip carrying an English promise rejects the whole answer", () => {
    expect(failure(["Welding seekhiye."], ["you will definitely get"])).toBe("promise");
  });

  it("matches whole words, case-insensitively", () => {
    expect(regionalWallFailure("YOU ARE THE BEST")).toBe("worker_rating");
    // "topper" and "bestseller" carry a listed word inside them; neither is the word.
    expect(regionalWallFailure("You are a topper")).toBeNull();
    expect(regionalWallFailure("You are reading a bestseller")).toBeNull();
    // "will getaway" is not "will get".
    expect(regionalWallFailure("Definitely, it will getaway")).toBeNull();
  });

  it("a live-news headline is held to the regional promise only, not the English walls", () => {
    expect(regionalPromise("Fuel prices will surely go up next month")).toBe(false);
    expect(regionalPromise("State guarantees minimum wage for factory workers")).toBe(false);
    expect(regionalPromise("Naukri nakki milel")).toBe(true);
  });

  it("the English lists are lowercase, deduplicated and fold to whole words", () => {
    for (const list of [
      ENGLISH_PROMISE_TOKENS,
      ENGLISH_SURELY_WORDS,
      ENGLISH_WILL_GET_WORDS,
      ENGLISH_RESPECTFUL_YOU,
      ENGLISH_RATING_FILLERS,
      ENGLISH_JUDGEMENT_WORDS,
    ]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
      for (const phrase of list) expect(phrase).toMatch(/^[a-z0-9]+(?:['\s][a-z0-9]+)*$/);
    }
  });

  it.each(ENGLISH_SENSITIVE_WORDS)("the English sensitive word %j is walled alone", (word) => {
    expect(regionalWallFailure(`Please read about ${word} first.`)).toBe("sensitive_advice");
  });

  it("the English sensitive list is single lowercase words, plurals in, 'doctor' out", () => {
    expect(new Set(ENGLISH_SENSITIVE_WORDS).size).toBe(ENGLISH_SENSITIVE_WORDS.length);
    for (const word of ENGLISH_SENSITIVE_WORDS) expect(word).toMatch(/^[a-z]+$/);
    for (const word of ["tablets", "painkillers", "medicines", "doses", "injections", "loans"]) {
      expect(ENGLISH_SENSITIVE_WORDS).toContain(word);
    }
    expect(ENGLISH_SENSITIVE_WORDS).not.toContain("doctor");
    expect(ENGLISH_SENSITIVE_WORDS).not.toContain("doctors");
  });
});

/**
 * #2184 (ADR-0051 R11): a job word followed by a future "will get" form, in one clause, is a
 * promise with no "pakka" and no surely word. Before this wall the gate SERVED every line in the
 * first table, the issue's two among them.
 */
describe("the soft job promise (#2184)", () => {
  it.each([
    ["the issue's Hinglish line", "Phir job mil jayegi."],
    ["an adjective before the job word", "Course ke baad aapko achhi job mil jayegi."],
    ["kaam, after a comma", "Mehnat kariye, kaam mil jayega."],
    ["mil jaayega", "Aapko yahan kaam mil jaayega."],
    ["mil jaayegi", "Is certificate se naukri mil jaayegi."],
    ["lag jayegi", "ITI ke baad naukri lag jayegi."],
    ["lag jaayegi on naukari", "Certificate se naukari lag jaayegi."],
    ["milegi hi", "Is skill se job milegi hi."],
    // The "jaega" / "jaegi" spellings; the first is a real Haiku reply from the #2181 eval.
    ["mil jaega", "phir apne aap kaam mil jaega"],
    ["lag jaegi", "certificate se naukri lag jaegi"],
    ["mil jaegi", "Course ke baad job mil jaegi."],
    // The "hi" of certainty inside the verb.
    ["mil hi jayegi", "Mehnat karte rahiye, job mil hi jayegi."],
    ["mil hi jaega", "Kaam mil hi jaega."],
    ["a filler between", "Experience ke saath job bhi mil jayegi."],
    ["two fillers between", "Job aapko jaldi mil jayegi."],
    ["zaroor between", "Job zaroor mil jayegi."],
    ["jaroor between", "Aapko job jaroor mil jayegi."],
    ["jaldi hi between", "Job jaldi hi mil jayegi."],
    ["to between", "Kaam to mil jayega."],
    ["aasani se between", "Job aasani se mil jayegi."],
    ["upper case", "JOB MIL JAYEGI"],
    // A negation word alone never unsays it: only a listed take-back, disclaimer or condition.
    ["a negation that is no disclaimer, before", "Tension mat lijiye job mil jayegi."],
    ["'shak nahi ki' is no disclaimer", "Isme koi shak nahi ki aapko job mil jayegi"],
    ["a later negation, after 'aur'", "Aapko job mil jayegi aur salary ki tension nahi rahegi."],
    ["a later negation, naukri", "Course ke baad naukri lag jayegi aur ghar baithna nahi padega."],
    ["a later 'shak nahi'", "Aapko job mil jayegi isme koi shak nahi."],
    ["a later 'mat', after a dash", "Job mil jayegi — chinta mat kijiye."],
    ["a later 'mat', no stop", "Job mil jayegi bas himmat mat haariye."],
    ["a later 'mat', in brackets", "Job mil jayegi (bas mehnat mat chhodiye)."],
    // A "to" BEFORE the job word is no condition.
    ["a 'to' before the job word", "agar ITI karenge to job mil jayegi"],
    // A bare "to" after the form is "so": the job is the promised result (re-review, #2184).
    ["'to' as 'so', twice", "Mehnat karoge to job mil jayegi to fir ghar ki tension khatam."],
    ["'to' as 'so'", "Job mil jayegi to tension mat lijiye."],
    ["'to' as 'so', kaam", "Kaam mil jayega to chinta ki koi baat nahi."],
    // A take-back followed by "ki" / "hai ki" opens a new statement and unsays that, not the job.
    [
      "zaroori nahi ki, after a comma",
      "Job mil jayegi, zaroori nahi ki shuru mein salary zyada ho.",
    ],
    [
      "yeh zaroori nahi ki, after a comma",
      "Naukri lag jayegi, yeh zaroori nahi ki pehli company hi best ho.",
    ],
    [
      "aisa nahi hai ki, after a comma",
      "Aapko kaam mil jayega, aisa nahi hai ki aapko kuch nahi karna padega.",
    ],
    ["aisa nahi ki, same clause", "Job mil jayegi aisa nahi ki mehnat nahi karni padegi."],
    // A "but", or a new subject after a "hai", ends a disclaimer's reach.
    ["par after a disclaimer", "Main yeh nahi keh sakta ki kitna samay lagega par job mil jayegi."],
    [
      "lekin after a disclaimer",
      "Zaroori nahi ki ITI hi karein lekin diploma se bhi job mil jayegi.",
    ],
    ["a new subject after 'hai'", "Yeh mat sochiye ki umar zyada hai aapko bhi job mil jayegi"],
    ["the issue's Kannada line", "Sthira kelasa milthade."],
    ["Kannada sigutte", "Neevu ITI maadidre kelasa sigutte."],
    ["Kannada kelsa", "Kelsa sigutte."],
    ["Kannada with the English noun", "Certificate idre job sigutte."],
    ["Tamil", "ITI mudichaa velai kidaikkum."],
    ["Telugu vastundi", "Course chesthe udyogam vastundi."],
    ["Telugu dorukutundi", "Meeru nerchukunte job dorukutundi."],
    ["Marathi", "Course kela tar naukri milel."],
    ["Gujarati", "Course karsho to nokri malse."],
  ])("%s: %j → promise", (_what, line) => {
    expect(failure([line])).toBe("promise");
    expect(regionalWallFailure(line)).toBe("promise");
  });

  it.each([
    // The issue's advice, and the brief's question.
    ["advice: the chance grows", "Koshish kariye, kaam milne ki sambhavna badhegi."],
    ["advice: it gets easier", "Certificate se job milne mein aasani hogi."],
    ["a question", "Kya aapko job mil jayegi, yeh company par nirbhar hai."],
    ["a question word after the form", "Is course ke baad job mil jayegi kya"],
    ["a question, the jaegi spelling", "kya job mil jaegi"],
    ["the clause a '?' closes", "Is course ke baad job mil jayegi? Yeh company par depend hai."],
    ["'milegi' alone is not a form", "Job turant nahi milegi, thoda samay lagega."],
    // A take-back right after the form, in the clause or across a comma or semicolon.
    ["a take-back in the clause", "Job mil jayegi ya nahi, yeh aapki skill par depend karta hai."],
    ["a take-back across a comma", "Sirf certificate se job mil jayegi, aisa nahi hai."],
    ["'yeh zaroori nahi' across a comma", "Job turant mil jayegi, yeh zaroori nahi."],
    ["a Marathi take-back across a comma", "Naukri milel, asa nahi; anubhav pan lagto."],
    // A disclaimer earlier in the clause than the job word.
    ["nahi keh sakta ki", "Main yeh nahi keh sakta ki job mil jayegi."],
    ["zaroori nahi ki", "Zaroori nahi ki turant job mil jayegi, thoda samay lag sakta hai."],
    ["aisa nahi hai ki", "Aisa nahi hai ki sirf certificate se job mil jayegi."],
    ["mat sochiye ki", "Yeh mat sochiye ki sirf degree se job mil jayegi."],
    // A condition word right after the form: the job is the condition.
    ["jab ... to", "Jab job mil jayegi to offer letter zaroor lijiye."],
    ["jab ... tab", "Jab naukri lag jayegi tab aap ESI card banwa sakte hain."],
    ["jab ... tab, across a comma", "Jab naukri lag jayegi, tab aap ESI card banwa sakte hain."],
    ["agar ... to, across a comma", "Agar job mil jayegi, to offer letter lijiye."],
    ["Tamil bodhu", "Velai kidaikkum bodhu offer letter vaangunga."],
    // Not a filler between, so not a job promise.
    ["understanding the work", "Kaam ki samajh mil jayegi."],
    ["work experience", "Welding seekhiye, phir kaam ka experience mil jayega."],
    ["work experience, the jaega spelling", "kaam ka experience mil jaega"],
    ["the work gets easy", "Practice se kaam aasaan ho jayega."],
    ["a job word alone", "Job ke liye resume zaroori hai."],
    // "lag jaega" is not a form: it takes effort.
    ["it will take some effort", "Is resume par thoda kaam lag jaega"],
    // Each §9 language's "chance of getting a job increases": another word than the future verb.
    ["Marathi chance", "Tumhi welding shikla tar kaam milnyachi shakyata vadhel."],
    ["Gujarati chance", "Certificate hoy to nokri malvani shakyata vadhe chhe."],
    ["Kannada chance", "Certificate idre kelasa sigo chance jaasti aagutte."],
    ["Tamil chance", "Certificate irundhaa velai kidaikka vaaippu adhigam."],
    ["Telugu chance", "Certificate unte udyogam dorike avakasam perugutundi."],
    // And each language's question and take-back.
    ["a Kannada question", "Certificate illade kelasa sigutte?"],
    // A "?" after empty clauses still closes the last clause with words.
    ["'...?'", "Job mil jayegi...?"],
    ["a Marathi take-back", "Fakt certificate ne naukri milel asa nahi."],
    ["a Tamil take-back", "Certificate mattum irundhaa velai kidaikkum nu illa."],
    ["a Gujarati take-back", "Fakt course thi nokri malse evu nathi."],
  ])("%s: %j is served", (_what, line) => {
    expect(failure([line])).toBeNull();
    expect(regionalWallFailure(line)).toBeNull();
  });

  it("a chip carrying a soft job promise rejects the whole answer", () => {
    expect(failure(["Welding seekhiye."], ["phir job mil jayegi"])).toBe("promise");
  });

  it("'!?' closes the clause as a question: the regional wall serves it, the '!' wall does not", () => {
    expect(regionalWallFailure("Job mil jayegi!?")).toBeNull();
    expect(regionalWallFailure("Job mil jayegi! Phir?")).toBe("promise");
    expect(failure(["Job mil jayegi!?"])).toBe("exclamation");
  });

  it("matches whole words: 'kaamyaab' and 'kaamyaabi' (success) are not job words", () => {
    expect(regionalWallFailure("Kaamyaab mil jayega")).toBeNull();
    expect(regionalWallFailure("Mehnat se kaamyaabi mil jayegi")).toBeNull();
  });

  it("a take-back is read across a comma or semicolon only, never across a sentence stop", () => {
    expect(regionalWallFailure("Job mil jayegi, aisa nahi hai.")).toBeNull();
    expect(regionalWallFailure("Job mil jayegi; aisa nahi hai.")).toBeNull();
    expect(regionalWallFailure("Job mil jayegi. Aisa nahi hai ki aaram milega.")).toBe("promise");
    // Only when the form ends the clause: a word after it is read first.
    expect(regionalWallFailure("Job mil jayegi aapko, aisa nahi hai.")).toBe("promise");
  });

  it("a 'to' / 'tab' after the form is a condition only once 'jab' / 'agar' / 'jo' opened it", () => {
    expect(regionalWallFailure("Jab job mil jayegi to offer letter lijiye.")).toBeNull();
    expect(regionalWallFailure("Jo naukri mil jayegi, tab uski salary slip rakhiye.")).toBeNull();
    expect(regionalWallFailure("Job mil jayegi to offer letter lijiye.")).toBe("promise");
    expect(regionalWallFailure("Job mil jayegi, to tension mat lijiye.")).toBe("promise");
    // A THEN word between the IF word and the job word closes the condition before the job.
    expect(regionalWallFailure("Agar ITI karenge to job mil jayegi to ghar chalega.")).toBe(
      "promise",
    );
    // Across a sentence stop, never: the IF word must sit in the job word's clause.
    expect(regionalWallFailure("Agar mehnat karenge. Job mil jayegi to khushi hogi.")).toBe(
      "promise",
    );
  });

  it("a take-back unsays the promise only when no new 'ki' statement follows it", () => {
    expect(regionalWallFailure("Job mil jayegi, aisa nahi hai.")).toBeNull();
    expect(regionalWallFailure("Job mil jayegi aisa nahi hai ki aaram milega.")).toBe("promise");
    expect(regionalWallFailure("Kaam mil jayega ki nahi, yeh aapki mehnat par hai.")).toBeNull();
  });

  it("a 'but' or a clause stop between a disclaimer and the job word ends its reach", () => {
    expect(
      regionalWallFailure("Zaroori nahi ki ITI hi karein, diploma se bhi job mil jayegi."),
    ).toBe("promise");
    expect(regionalWallFailure("Zaroori nahi ki ITI ke baad turant job mil jayegi.")).toBeNull();
    expect(regionalWallFailure("Zaroori nahi ki ITI hi karein magar job mil jayegi.")).toBe(
      "promise",
    );
  });

  it("'milthade' joins the regional will-get list, so the surely pair reads it too", () => {
    expect(REGIONAL_WILL_GET_WORDS).toContain("milthade");
    expect(regionalWallFailure("Khanditavagi milthade.")).toBe("promise");
  });

  it("a live-news headline is not held to the soft job promise", () => {
    expect(regionalPromise("Yuvaon ko naukri mil jayegi: mantri")).toBe(false);
  });

  it("the soft-promise lists are lowercase, deduplicated and fold to whole words", () => {
    for (const list of [
      SOFT_PROMISE_JOB_WORDS,
      SOFT_PROMISE_QUESTION_WORDS,
      SOFT_PROMISE_CONDITIONS,
      SOFT_PROMISE_IF_WORDS,
      SOFT_PROMISE_THEN_WORDS,
    ]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
      for (const word of list) expect(word).toMatch(/^[a-z]+$/);
    }
    for (const list of [
      SOFT_PROMISE_WILL_GET_PHRASES,
      SOFT_PROMISE_FILLERS,
      SOFT_PROMISE_TAKE_BACKS,
      SOFT_PROMISE_NEW_STATEMENT,
      SOFT_PROMISE_DISCLAIMERS,
      SOFT_PROMISE_DISCLAIMER_BREAKS,
    ]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
      for (const phrase of list) expect(phrase).toMatch(/^[a-z]+(?: [a-z]+)*$/);
    }
    for (const phrase of SOFT_PROMISE_WILL_GET_PHRASES) expect(phrase).toContain(" ");
    // "se" is a filler only inside "aasani se", and "lag jaega" ("it takes effort") is no form.
    expect(SOFT_PROMISE_FILLERS).not.toContain("se");
    expect(SOFT_PROMISE_WILL_GET_PHRASES).not.toContain("lag jaega");
    // A negation word alone never unsays the promise: every take-back and disclaimer is a phrase.
    for (const phrase of [...SOFT_PROMISE_TAKE_BACKS, ...SOFT_PROMISE_DISCLAIMERS]) {
      expect(phrase).toContain(" ");
    }
    // A bare "to" / "tab" is "so" and no condition: they are THEN words, needing an IF word.
    expect(SOFT_PROMISE_CONDITIONS).not.toContain("to");
    expect(SOFT_PROMISE_CONDITIONS).not.toContain("tab");
  });

  it("no question word is a job word, a filler or a will-get word", () => {
    const shape = new Set([
      ...SOFT_PROMISE_JOB_WORDS,
      ...SOFT_PROMISE_FILLERS.flatMap((phrase) => phrase.split(" ")),
      ...REGIONAL_WILL_GET_WORDS,
      ...SOFT_PROMISE_WILL_GET_PHRASES.flatMap((phrase) => phrase.split(" ")),
    ]);
    for (const word of SOFT_PROMISE_QUESTION_WORDS) expect(shape.has(word)).toBe(false);
  });
});

describe("the lists stay closed and well formed", () => {
  const lists = {
    REGIONAL_PERSONA_TOKENS,
    REGIONAL_PROMISE_TOKENS,
    REGIONAL_SURELY_WORDS,
    REGIONAL_WILL_GET_WORDS,
    REGIONAL_SENSITIVE_WORDS,
    REGIONAL_RESPECTFUL_YOU,
    REGIONAL_JUDGEMENT_WORDS,
  };

  it.each(Object.entries(lists))("%s: lowercase Latin single words, no duplicates", (_n, list) => {
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list).size).toBe(list.length);
    for (const word of list) expect(word).toMatch(/^[a-z]+$/);
  });

  it("no word the reply prompts ASK FOR is banned", () => {
    const banned = new Set([...REGIONAL_PERSONA_TOKENS, ...REGIONAL_SENSITIVE_WORDS]);
    for (const asked of REGIONAL_RESPECTFUL_YOU) expect(banned.has(asked)).toBe(false);
    for (const asked of ["aap", "unga", "mee", "nimma", "tumcha"]) {
      expect(banned.has(asked)).toBe(false);
    }
  });
});
