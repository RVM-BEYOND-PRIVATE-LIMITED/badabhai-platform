/**
 * @badabhai/profiling-lexicon — the Hinglish occupational lexicon.
 *
 * Barrel only. Everything is defined in the five owned subdirectories:
 *   normalize/   Divyanshu — occupation-text normalization (seeder + retrieval share it)
 *   retrieval/   Divyanshu — L0/L1 span search (the eval harness + the live service share it)
 *   persona/     Divyanshu — the product's voice, lifted from persona.py before Phase 8 deletes it
 *   predicates/  Prakash   — conversational detectors, one per turn
 *   values/      Prakash   — value normalizers, the negation engine, the field crosswalk
 *
 * The subdirectory split is deliberate: it is the ownership boundary. Two developers work
 * in this package concurrently and should never edit the same file.
 *
 * See README.md for the two guards that keep the TS and Python readers honest — the
 * common-regex-subset rule, and the shared golden corpus.
 */

export * from "./normalize/index.js";
export * from "./retrieval/index.js";
export * from "./persona/index.js";
export * from "./predicates/index.js";
export * from "./values/index.js";
