"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { Icon } from "@badabhai/icons";
import { looksLikePii } from "@badabhai/validators";
import { Button, Input, Select, Textarea } from "../../../../../components/ds";
import { ChipEditor } from "../../../../../components/chip-editor";
import {
  PostingActions,
  PostingPreviewRail,
  zeroReachLabel,
} from "../../../../../components/posting-preview-rail";
import {
  NEEDED_BY,
  PAY_TYPES,
  SHIFTS,
  type MatchSkillWire,
  type PostingTradeFormWire,
  type ReachPreview,
} from "../../../../../lib/contracts";
import {
  POSTING_TRADE_REQUIRED_MESSAGE,
  isPostingTrade,
  type PostingTradesProblem,
} from "../../../../../lib/posting-trades";
import { neededByLabel, payTypeLabel, shiftLabel } from "../../../../../lib/job-card-view";
import {
  CARD_NUMBER_FIELDS,
  cardIssueMessage,
  gapInputFromValues,
  liveCardFieldError,
  parseWholeNumber,
  readCardForm,
  withChipDraft,
  ALL_NUMBERS_REVEALED,
  numberPairOf,
  revealNumberPair,
  type CardNumberField,
  type CardNumberPair,
  type RevealedNumbers,
} from "../../../../../lib/job-card-form";
import {
  focusControl,
  focusControlOnNextFrame,
  focusIsLost,
  revealWholeControl,
} from "../../../../../lib/form-focus";
import { companyPostingFacts } from "../../../../../lib/posting-facts";
import { workerCardGap, workerCardGaps } from "../../../../../lib/worker-card-gap";
import type { PostingEditInitial } from "../../../../../lib/payer-api";
import type { MatchSelection } from "../../new/match-skill-picker";
import { TradePostingFields, derivedMatchSkills, type TradeFormValue } from "../../trade-fields";
import { PostingTradePicker } from "../../trade-picker";
import { updatePostingAction } from "./actions";
import { withPublishedReach } from "../../../../../lib/published-reach";
import { usePortalNavigation } from "../../../../../components/portal-navigation";
import { postingDraftKey } from "../../../../../lib/posting-draft";
import { usePostingDraft } from "../../../../../components/use-posting-draft";
import { DraftRestoredNotice } from "../../../../../components/draft-restored-notice";

/**
 * Edit a posting (EMPLOYER self-serve; LIVE `PATCH /payer/job-postings/:id`). Every card field +
 * the role + its trade's fields (prefilled), beside the {@link PostingPreviewRail} — the worker's
 * card built from the SAME `readCardForm` values the save sends. DRAFT → "Save draft" (no gap
 * block) + "Publish posting" (gap block + ≥1 skill). OPEN/PAUSED → "Save changes" (gaps
 * HIGHLIGHTED, never blocked — owner ruling). The `initial` prop drives the `clear` diff (a
 * blanked field is unset server-side); the page keys this form on the saved revision, so it is
 * re-seeded whenever the server copy changes.
 *
 * #2645 — THE ROLE IS THE JOB'S TRADE, one of the 16 (#2635). It is picked only from the 16 the API
 * served (no free role list, no flat skill picker; if they did not load, the picker says why with a
 * Retry). It is sent only when the payer moved it to another trade and is never cleared, so an
 * unrelated save cannot move a live job off the 16. A publish needs one, and the API's
 * `posting_trade_required` refusal lands AT the picker ("Pick one of the 16 trades"), as does a page
 * opened with `?trade=required` (a publish refused elsewhere). A publish always carries the trade
 * form, so the server derives the match set from the trade — the set the trade panel previews.
 */

const FORM_ID = "edit-posting-form";

interface FormFields {
  roleTitle: string;
  roleKind: string;
  locationLabel: string;
  vacancies: string;
  city: string;
  area: string;
  payMin: string;
  payMax: string;
  payType: string;
  minExperienceYears: string;
  maxExperienceYears: string;
  shift: string;
  neededBy: string;
  description: string;
}

export interface EditPostingInitial extends PostingEditInitial {
  roleTitle: string;
  /** A count INSIDE the stored band, as the edit seed (the server re-derives from a submitted count). */
  vacanciesHint: number;
}

function seedEnum(value: string | null, allowed: readonly string[]): string {
  return value !== null && allowed.includes(value) ? value : "";
}

/** The form's fields as seeded from the saved posting — also what "unchanged" means (W4). */
function seedFields(initial: EditPostingInitial): FormFields {
  return {
    roleTitle: initial.roleTitle,
    roleKind: initial.roleKind ?? "",
    locationLabel: initial.locationLabel ?? "",
    vacancies: String(initial.vacanciesHint),
    city: initial.city ?? "",
    area: initial.area ?? "",
    payMin: initial.payMin !== null ? String(initial.payMin) : "",
    payMax: initial.payMax !== null ? String(initial.payMax) : "",
    payType: seedEnum(initial.payType, PAY_TYPES),
    minExperienceYears:
      initial.minExperienceYears !== null ? String(initial.minExperienceYears) : "",
    maxExperienceYears:
      initial.maxExperienceYears !== null ? String(initial.maxExperienceYears) : "",
    shift: seedEnum(initial.shift, SHIFTS),
    neededBy: seedEnum(initial.neededBy, NEEDED_BY),
    description: initial.description ?? "",
  };
}

/** What an edit's draft keeps on this device (W4). */
interface EditPostingDraft {
  fields: FormFields;
  requirements: string[];
  benefits: string[];
  reqDraft: string;
  benDraft: string;
  trade: TradeFormValue & { matchSkillIds: string[]; dirty: boolean };
  legacySelection: MatchSelection;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * True once the payer changed anything the saved posting holds. Not the old flat pick
 * (`legacySelection`): no control sets it since #2645 and it is never sent, so a pick restored from
 * an older draft is no change to lose.
 */
export function isEditPostingDirty(draft: EditPostingDraft, initial: EditPostingInitial): boolean {
  return (
    !sameJson(draft.fields, seedFields(initial)) ||
    !sameJson(draft.requirements, initial.requirements ?? []) ||
    !sameJson(draft.benefits, initial.benefits ?? []) ||
    draft.reqDraft.trim() !== "" ||
    draft.benDraft.trim() !== "" ||
    draft.trade.dirty ||
    draft.trade.tradeLevel !== (initial.tradeLevel ?? "") ||
    !sameJson(draft.trade.answers, initial.tradeAnswers ?? {})
  );
}

export function EditPostingForm({
  payerId,
  postingId,
  status,
  initial,
  matchSkills = [],
  matchSelection,
  postingTrades = [],
  postingTradesProblem = null,
  tradeRequired = false,
  lead,
}: {
  /** The signed-in payer (the session's opaque id) — the local draft is kept per payer (W4). */
  payerId: string;
  postingId: string;
  status: string;
  initial: EditPostingInitial;
  matchSkills?: MatchSkillWire[];
  matchSelection?: MatchSelection;
  /** The 16-trade posting catalogue (migration 0141) — the only roles a company job can name. */
  postingTrades?: PostingTradeFormWire[];
  /** Why `postingTrades` is empty (#2645) — said at the picker, with a Retry. */
  postingTradesProblem?: PostingTradesProblem | null;
  /** #2645 — opened because the API would not put this job live without one of the 16 trades. */
  tradeRequired?: boolean;
  /** The page head, drawn at the top of the form column (the rail starts beside it). */
  lead?: ReactNode;
}) {
  // useState order (mirrored positionally by edit-posting-form.test.tsx): fields, requirements,
  // benefits, reqDraft, benDraft, error, trade, preview, revealed, navigating, problem,
  // submitting, serverFieldErrors, legacySelection. APPEND new state only.
  const [fields, setFields] = useState<FormFields>(seedFields(initial));
  const [requirements, setRequirements] = useState<string[]>(initial.requirements ?? []);
  const [benefits, setBenefits] = useState<string[]>(initial.benefits ?? []);
  const [reqDraft, setReqDraft] = useState("");
  const [benDraft, setBenDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A posting created with the trade form stores answers; its match set is exactly the set
  // those answers derive, so seed from them rather than from a possibly stale row echo (a
  // draft save persists answers before its first publish materializes the match set).
  const storedTradeSeed =
    (initial.tradeLevel ?? null) !== null || (initial.tradeAnswers ?? null) !== null;
  const initialTradeForm = postingTrades.find((form) => form.role_kind === initial.roleKind);
  const seedTrade = (): TradeFormValue & { matchSkillIds: string[]; dirty: boolean } => ({
    tradeLevel: initial.tradeLevel ?? "",
    answers: initial.tradeAnswers ?? {},
    matchSkillIds:
      storedTradeSeed && initialTradeForm
        ? derivedMatchSkills(initialTradeForm, initial.tradeAnswers ?? {})
        : (matchSelection?.matchSkillIds ?? []),
    dirty: false,
  });
  const [trade, setTrade] = useState<TradeFormValue & { matchSkillIds: string[]; dirty: boolean }>(
    seedTrade(),
  );
  const [preview, setPreview] = useState<ReachPreview | null>(null);
  const [revealed, setRevealed] = useState<RevealedNumbers>({});
  // Set the moment a save succeeds: the buttons stay disabled through the navigation and the
  // revision-keyed remount, so a second click cannot send the same save again.
  const [navigating, setNavigating] = useState(false);
  // The refused save's reason, shown AT the control focus moves to (and in the status line). A page
  // opened refused for want of a trade (#2645) starts with it at the picker, until a trade is picked.
  const [problem, setProblem] = useState<{ control: string; message: string } | null>(
    tradeRequired ? { control: "roleKind", message: POSTING_TRADE_REQUIRED_MESSAGE } : null,
  );
  // Which button's request is in flight — so only Publish reads "Publishing…" (a draft save
  // shares the same pending state).
  const [submitting, setSubmitting] = useState<"save" | "publish" | null>(null);
  // The server's per-field refusals (#1912), keyed by form control. APPENDED after the seeded
  // prefix (the test mirrors the earlier states positionally).
  const [serverFieldErrors, setServerFieldErrors] = useState<Record<string, string>>({});
  // The legacy flat picker's selection. No flat picker since #2645 (the trade owns the match set);
  // kept for the stored draft's shape (W4). APPENDED too, so the earlier positional state order is
  // unchanged.
  const [legacySelection, setLegacySelection] = useState<MatchSelection>(
    matchSelection ?? { matchSkillIds: [], untickedRelatedIds: [] },
  );
  const [pending, startTransition] = useTransition();
  // A saved form lands on the posting with the shell's "Opening <title>…" cue; its button stays
  // pending (`navigating`) until the page is gone.
  const { navigate } = usePortalNavigation();

  // W4 — unsaved edits are kept on this device (only over the SAME saved copy: the base is the
  // seed) and leaving with them asks first.
  const draftPayload: EditPostingDraft = {
    fields,
    requirements,
    benefits,
    reqDraft,
    benDraft,
    trade,
    legacySelection,
  };
  const draft = usePostingDraft<EditPostingDraft>({
    storageKey: postingDraftKey({ kind: "edit", payerId, postingId }),
    base: JSON.stringify({ status, initial, matchSelection: matchSelection ?? null }),
    payload: draftPayload,
    dirty: isEditPostingDirty(draftPayload, initial),
    off: navigating,
    onRestore: (saved) => {
      setFields({ ...seedFields(initial), ...saved.fields });
      setRequirements(saved.requirements ?? []);
      setBenefits(saved.benefits ?? []);
      setReqDraft(saved.reqDraft ?? "");
      setBenDraft(saved.benDraft ?? "");
      if (saved.trade) setTrade(saved.trade);
      if (saved.legacySelection) setLegacySelection(saved.legacySelection);
    },
  });

  /** The payer dropped the changes restored from this device: the saved posting again (W4). */
  function discardRestored() {
    draft.discard();
    setFields(seedFields(initial));
    setRequirements(initial.requirements ?? []);
    setBenefits(initial.benefits ?? []);
    setReqDraft("");
    setBenDraft("");
    setError(null);
    setTrade(seedTrade());
    setPreview(null);
    setRevealed({});
    setProblem(null);
    setServerFieldErrors({});
    setLegacySelection(matchSelection ?? { matchSkillIds: [], untickedRelatedIds: [] });
  }

  const isDraft = status === "draft";
  const tradeMode = postingTrades.length > 0;
  // A posting created before migration 0141 has no trade fields and may carry a hand-picked
  // match set. Showing the trade panel there would let a display-only rung (or a facet chip)
  // rewrite that set to the role's base skill — a silent reach loss. The panel is therefore
  // for drafts and for postings that already use the trade form; a ROLE change reveals it too,
  // because that is an explicit replacement of the old trade.
  const showTradeForm = tradeMode && (isDraft || storedTradeSeed || trade.dirty);
  // #2645 — the stored role, as stored: it is sent only when the payer moved it to another trade.
  const roleTouched = fields.roleKind !== (initial.roleKind ?? "");
  // The match set the publish button, the rail and the PATCH all read. Wherever the trade panel is
  // shown it is EXACTLY what the panel previews — the trade's own skill plus its match chips — so a
  // draft an older client saved with a hand-picked set publishes its trade's set, never those free
  // skills (#2645). Only a posting the panel is hidden for (a live one from before migration 0141,
  // which never publishes from here) shows its stored set; an empty one, its trade's own skill.
  const tradeForm = postingTrades.find((form) => form.role_kind === fields.roleKind);
  const activeMatchSkillIds =
    tradeForm !== undefined && (showTradeForm || trade.matchSkillIds.length === 0)
      ? derivedMatchSkills(tradeForm, trade.answers)
      : trade.matchSkillIds;

  // #2645 — opened refused (`?trade=required`): focus starts AT the trade picker, in whichever form
  // it is drawn — the 16 trades' select, or the spot that names why they did not load (a group,
  // which React's `autoFocus` never focuses). A Retry that brings the 16 back draws the select in
  // that spot. Focus follows it there only when it was lost (the Retry button it was on is gone):
  // a payer who moved on to another control keeps it, since focus pulled onto the select as they
  // type would let its type-ahead change the trade.
  const tradeFocusTaken = useRef(false);
  useEffect(() => {
    if (!tradeRequired) return;
    if (tradeFocusTaken.current && !focusIsLost()) return;
    tradeFocusTaken.current = true;
    focusControlOnNextFrame("roleKind");
  }, [tradeRequired, tradeMode]);

  // THE ONE READ — the preview, the inline errors, the gaps and the save all use it.
  const read = readCardForm(
    { ...fields, title: fields.roleTitle },
    { requirements, benefits, reqDraft, benDraft },
  );

  function set<K extends keyof FormFields>(key: K, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
    if (key === "roleKind") {
      const form = postingTrades.find((tradeForm) => tradeForm.role_kind === value);
      setTrade({
        tradeLevel: "",
        answers: {},
        matchSkillIds: form ? derivedMatchSkills(form, {}) : [],
        dirty: true,
      });
      setPreview(null);
    }
    const pair = numberPairOf(key);
    if (pair !== null) setRevealed((prev) => revealNumberPair(prev, pair, false));
    clearRefusalAt(key);
  }

  /**
   * The payer is fixing the control a refused save pointed at: that refusal is over. Drop its
   * message WITH its field mark — a message left without its field would read as a refusal no
   * field owns and fall into the live slot, re-announced mid-fix. A SERVER field error (#1912)
   * on that control clears with it.
   */
  function clearRefusalAt(control: string) {
    setServerFieldErrors((prev) => {
      if (!(control in prev)) return prev;
      const next = { ...prev };
      delete next[control];
      return next;
    });
    if (problem === null || problem.control !== control) return;
    setProblem(null);
    setError(null);
  }

  /** Leaving one end of a min/max pair shows that pair's order error (typing never flashes it). */
  function reveal(pair: CardNumberPair) {
    setRevealed((prev) => revealNumberPair(prev, pair, true));
  }

  const numberError = (key: CardNumberField) =>
    liveCardFieldError(read.issues, key, revealed[key] === true);

  /**
   * A control's error: its own live check first, then a SERVER field error (#1912 — the API
   * refused this field at write), then the refused save's reason.
   */
  const errorOf = (control: string, own?: string) =>
    own ??
    serverFieldErrors[control] ??
    (problem !== null && problem.control === control ? problem.message : undefined);

  /** The gaps STILL open — highlighted (never blocked) so the payer sees what the card is missing. */
  const gaps = workerCardGaps(gapInputFromValues(read.values, fields.description));

  /** The first problem a save would hit, with the control to take the payer to. */
  function clientValidate(): { message: string; control: string } | null {
    if ([...fields.roleTitle.trim()].length < 2) {
      return { message: "Role title must be at least 2 characters.", control: "roleTitle" };
    }
    const count = parseWholeNumber(fields.vacancies);
    if (count.kind !== "ok" || count.value <= 0) {
      return { message: "Openings must be a positive number.", control: "vacancies" };
    }
    if (fields.description.trim() !== "" && looksLikePii(fields.description)) {
      return {
        message: "Remove contact details (phone/email) from the description.",
        control: "description",
      };
    }
    // A number that cannot be saved as typed must block the save: sending it as "not stated"
    // would CLEAR the stored value through the `clear` diff.
    for (const field of CARD_NUMBER_FIELDS) {
      const issue = read.issues[field];
      if (issue !== undefined) return { message: cardIssueMessage(field, issue), control: field };
    }
    return null;
  }

  function submit(mode: "save" | "publish") {
    // A chip still in its box is part of the posting (`read.values` carries it) — show it added.
    setRequirements(read.values.requirements);
    setBenefits(read.values.benefits);
    setReqDraft("");
    setBenDraft("");

    // #2645 — a publish needs one of the 16 trades, and a role the payer moved must land on one
    // (blanking a stored role is refused, never sent as a clear). Refused AT the picker, before
    // anything is sent; an untouched role is never checked (it is not sent either).
    if (!isPostingTrade(postingTrades, fields.roleKind) && (mode === "publish" || roleTouched)) {
      setError(POSTING_TRADE_REQUIRED_MESSAGE);
      setProblem({ control: "roleKind", message: POSTING_TRADE_REQUIRED_MESSAGE });
      focusControl("roleKind");
      return;
    }
    const refused = clientValidate();
    if (refused !== null) {
      setError(refused.message);
      setProblem(refused);
      if (Object.keys(read.issues).length > 0) setRevealed(ALL_NUMBERS_REVEALED);
      focusControl(refused.control);
      return;
    }
    if (mode === "publish") {
      // The action re-runs the gap rule (the authority); checking here first takes the payer
      // straight to the missing field instead of round-tripping.
      const gap = workerCardGap(gapInputFromValues(read.values, fields.description));
      if (gap !== null) {
        setError(`${gap.title}: ${gap.message}`);
        setProblem({ control: gap.field, message: gap.message });
        focusControl(gap.field);
        return;
      }
    }
    setError(null);
    setProblem(null);
    setServerFieldErrors({});
    setSubmitting(mode);
    const v = read.values;
    const count = parseWholeNumber(fields.vacancies);
    startTransition(async () => {
      const res = await updatePostingAction({
        postingId,
        roleTitle: v.title,
        // #2645 — only a role the payer moved (to one of the 16, checked above) is sent.
        roleKind: roleTouched ? v.roleKind : undefined,
        // OMIT the count when untouched — re-submitting the prefill hint would re-derive (and for a
        // "25+" posting DOWNGRADE) the stored band on an unrelated edit.
        vacancies:
          fields.vacancies === String(initial.vacanciesHint) || count.kind !== "ok"
            ? undefined
            : count.value,
        locationLabel: fields.locationLabel.trim() || undefined,
        description: fields.description.trim() || undefined,
        city: v.city,
        area: v.area,
        payMin: v.payMin,
        payMax: v.payMax,
        payType: v.payType,
        minExperienceYears: v.minExperienceYears,
        maxExperienceYears: v.maxExperienceYears,
        shift: v.shift,
        neededBy: v.neededBy,
        requirements: v.requirements,
        benefits: v.benefits,
        // Send the trade fields when the payer edited them OR the posting already has them,
        // so an unrelated save cannot trip the clear diff and silently erase the answers — and
        // on EVERY publish (#2645): `{}` when untouched still names the trade, so the server
        // derives the match set from it (as the create does) and the job goes live with its form.
        ...(trade.dirty || storedTradeSeed || mode === "publish"
          ? {
              tradeLevel: trade.tradeLevel || undefined,
              tradeAnswers: trade.answers,
            }
          : {}),
        initial,
        ...(mode === "publish"
          ? {
              publish: {
                matchSkillIds: activeMatchSkillIds,
                // The stored untick choice belongs to the stored trade selection: kept only while
                // that is what publishes. Otherwise none, as the panel's reach preview counted.
                untickedRelatedIds:
                  trade.dirty || !storedTradeSeed ? [] : (matchSelection?.untickedRelatedIds ?? []),
              },
            }
          : {}),
      });
      if (res.ok) {
        setNavigating(true);
        draft.discard();
        // Refresh as well as navigate: the router cache must not hand a later Back the pre-save
        // edit page (and its pre-save `initial`, which drives the clear diff).
        navigate(withPublishedReach(`/postings/${postingId}`, res.reached), {
          pendingLabel: res.posting.roleTitle,
          refresh: true,
        });
      } else if (res.tradeRequired) {
        // #2645 — the API would not put (or keep) this job live without one of the 16 trades:
        // said AT the trade picker, where focus goes — never the server's sentence.
        setError(res.error);
        setProblem({ control: "roleKind", message: res.error });
        focusControl("roleKind");
      } else {
        // #1912 — a server validation 400 names the refused field; show it inline at its control.
        if (res.fieldErrors) setServerFieldErrors(res.fieldErrors);
        setError(res.error);
      }
    });
  }

  function addChip(kind: "req" | "ben") {
    clearRefusalAt(kind === "req" ? "requirements" : "benefits");
    if (kind === "req") {
      setRequirements((prev) => withChipDraft(prev, reqDraft).list);
      setReqDraft("");
    } else {
      setBenefits((prev) => withChipDraft(prev, benDraft).list);
      setBenDraft("");
    }
  }

  const busy = pending || navigating;
  // Only a request in flight disables Publish: a missing trade is said by the click (#2645).
  const publishDisabled = busy;
  const primary = isDraft ? (
    <Button
      type="button"
      loading={busy && submitting === "publish"}
      disabled={publishDisabled}
      iconRight="rocket-launch"
      onClick={() => submit("publish")}
    >
      {busy && submitting === "publish"
        ? "Publishing…"
        : preview?.zero_reach
          ? zeroReachLabel
          : "Publish posting"}
    </Button>
  ) : (
    <Button type="submit" form={FORM_ID} loading={busy} disabled={busy}>
      Save changes
    </Button>
  );
  // ONE status: the rail footer on desktop, the dock below 1024px (the form's end repeats only
  // the buttons) — the reason a save was refused sits by the button the payer pressed.
  const refusal =
    error !== null ? (
      <p className="posting-actions__msg posting-actions__msg--danger">
        <strong>Your changes were not saved.</strong> {error}
      </p>
    ) : null;
  // A refusal a FIELD owns (`problem`) is not announced here: focus moves to that field, whose
  // description reads the reason — once. One no field owns (the server's) is announced, from the
  // live slot.
  const statusLine = (
    <>
      {gaps.length > 0 ? (
        <p className="posting-actions__msg posting-actions__msg--warning" role="status">
          <strong>Still to fill:</strong> {gaps.map((g) => g.title.toLowerCase()).join(", ")}.
          {isDraft ? " Publishing needs them filled." : " You can save now and finish later."}
        </p>
      ) : null}
      {problem !== null ? refusal : null}
    </>
  );
  const outcomeLine = problem === null ? refusal : null;
  const buttons = (
    <>
      {isDraft ? (
        <Button
          type="submit"
          form={FORM_ID}
          variant="secondary"
          loading={busy && submitting === "save"}
          disabled={busy}
        >
          Save draft
        </Button>
      ) : null}
      {primary}
    </>
  );

  return (
    <div className="posting-layout posting-layout--editor">
      <div className="posting-layout__main">
        {lead}
        <form
          id={FORM_ID}
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            submit("save");
          }}
        >
          <p
            className="mw-draft-cue"
            data-shown={draft.saved ? "true" : "false"}
            aria-hidden={!draft.saved}
          >
            <Icon name="check-circle" /> Draft saved on this device
          </p>
          {draft.restored ? <DraftRestoredNotice onDiscard={discardRestored} /> : null}
          <div className="form__section">
            <p className="form__legend">The role</p>
            <PostingTradePicker
              id="roleKind"
              label="Role"
              hint="One of the 16 trades we match on — it decides which workers see this posting."
              trades={postingTrades}
              problem={postingTradesProblem}
              value={fields.roleKind}
              error={errorOf("roleKind")}
              onChange={(value) => set("roleKind", value)}
            />
            <Input
              id="roleTitle"
              label="Role title"
              value={fields.roleTitle}
              error={errorOf("roleTitle")}
              aria-invalid={errorOf("roleTitle") ? true : undefined}
              hint="The heading of the worker's card."
              onChange={(e) => set("roleTitle", e.target.value)}
              required
            />
            <div className="form-grid">
              <Input
                id="locationLabel"
                label="Location note"
                optional
                value={fields.locationLabel}
                onChange={(e) => set("locationLabel", e.target.value)}
              />
              <Input
                id="vacancies"
                label="Openings"
                inputMode="numeric"
                value={fields.vacancies}
                error={errorOf("vacancies")}
                aria-invalid={errorOf("vacancies") ? true : undefined}
                onChange={(e) => set("vacancies", e.target.value)}
                required
              />
            </div>
            <div className="form-grid">
              <Input
                id="city"
                label="City"
                value={fields.city}
                error={errorOf("city")}
                aria-invalid={errorOf("city") ? true : undefined}
                onChange={(e) => set("city", e.target.value)}
              />
              <Input
                id="area"
                label="Area / locality"
                optional
                value={fields.area}
                onChange={(e) => set("area", e.target.value)}
              />
            </div>
          </div>

          <div className="form__section">
            <p className="form__legend">Pay and timing</p>
            <div className="form-grid">
              <Input
                id="payMin"
                label="Pay — min (₹ / month)"
                inputMode="numeric"
                value={fields.payMin}
                error={errorOf("payMin", numberError("payMin"))}
                aria-invalid={errorOf("payMin", numberError("payMin")) ? true : undefined}
                onChange={(e) => set("payMin", e.target.value)}
                onBlur={() => reveal("pay")}
              />
              <Input
                id="payMax"
                label="Pay — max (₹ / month)"
                inputMode="numeric"
                value={fields.payMax}
                error={errorOf("payMax", numberError("payMax"))}
                aria-invalid={errorOf("payMax", numberError("payMax")) ? true : undefined}
                onChange={(e) => set("payMax", e.target.value)}
                onBlur={() => reveal("pay")}
              />
            </div>
            <Select
              id="payType"
              label="Pay type"
              value={fields.payType}
              error={errorOf("payType")}
              aria-invalid={errorOf("payType") ? true : undefined}
              onChange={(e) => set("payType", e.target.value)}
            >
              <option value="">— pick the pay type —</option>
              {PAY_TYPES.map((p) => (
                <option key={p} value={p}>
                  {payTypeLabel(p)}
                </option>
              ))}
            </Select>
            <div className="form-grid">
              <Input
                id="minExperienceYears"
                label="Experience — min (years)"
                inputMode="numeric"
                value={fields.minExperienceYears}
                error={errorOf("minExperienceYears", numberError("minExperienceYears"))}
                aria-invalid={
                  errorOf("minExperienceYears", numberError("minExperienceYears"))
                    ? true
                    : undefined
                }
                onChange={(e) => set("minExperienceYears", e.target.value)}
                onBlur={() => reveal("experience")}
              />
              <Input
                id="maxExperienceYears"
                label="Experience — max (years)"
                inputMode="numeric"
                value={fields.maxExperienceYears}
                error={errorOf("maxExperienceYears", numberError("maxExperienceYears"))}
                aria-invalid={
                  errorOf("maxExperienceYears", numberError("maxExperienceYears"))
                    ? true
                    : undefined
                }
                onChange={(e) => set("maxExperienceYears", e.target.value)}
                onBlur={() => reveal("experience")}
              />
            </div>
            <div className="form-grid">
              <Select
                id="shift"
                label="Shift"
                value={fields.shift}
                error={errorOf("shift")}
                aria-invalid={errorOf("shift") ? true : undefined}
                onChange={(e) => set("shift", e.target.value)}
              >
                <option value="">— pick the shift —</option>
                {SHIFTS.map((s) => (
                  <option key={s} value={s}>
                    {shiftLabel(s)}
                  </option>
                ))}
              </Select>
              <Select
                id="neededBy"
                label="Needed by"
                value={fields.neededBy}
                error={errorOf("neededBy")}
                aria-invalid={errorOf("neededBy") ? true : undefined}
                onChange={(e) => set("neededBy", e.target.value)}
              >
                <option value="">— pick joining time —</option>
                {NEEDED_BY.map((n) => (
                  <option key={n} value={n}>
                    {neededByLabel(n)}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="form__section">
            <p className="form__legend">Requirements and benefits</p>
            <ChipEditor
              id="requirements"
              label="Requirements"
              placeholder="e.g. Fanuc control"
              draft={reqDraft}
              items={requirements}
              error={errorOf("requirements")}
              onDraft={setReqDraft}
              onAdd={() => addChip("req")}
              onRemove={(i) => setRequirements((p) => p.filter((_, j) => j !== i))}
            />
            <ChipEditor
              id="benefits"
              label="Benefits"
              placeholder="e.g. PF + ESI"
              draft={benDraft}
              items={benefits}
              error={errorOf("benefits")}
              onDraft={setBenDraft}
              onAdd={() => addChip("ben")}
              onRemove={(i) => setBenefits((p) => p.filter((_, j) => j !== i))}
            />
          </div>

          <div className="form__section">
            <p className="form__legend">Description</p>
            <Textarea
              id="description"
              label="Description"
              onFocus={revealWholeControl}
              value={fields.description}
              error={errorOf("description")}
              aria-invalid={errorOf("description") ? true : undefined}
              hint="Workers read this when they open the posting. No phone number or email."
              onChange={(e) => set("description", e.target.value)}
              rows={4}
            />
          </div>

          {showTradeForm ? (
            <TradePostingFields
              trades={postingTrades}
              roleKind={fields.roleKind}
              value={{ tradeLevel: trade.tradeLevel, answers: trade.answers }}
              onChange={(next) => {
                const form = postingTrades.find((t) => t.role_kind === fields.roleKind);
                setTrade({
                  ...next,
                  matchSkillIds: form ? derivedMatchSkills(form, next.answers) : [],
                  dirty: true,
                });
              }}
              onMatchSkillIdsChange={() => undefined}
              onPreviewChange={setPreview}
              vocabulary={matchSkills}
              reachRoleKind={fields.roleKind || undefined}
            />
          ) : null}

          <div className="posting-layout__end">
            <PostingActions>{buttons}</PostingActions>
          </div>
        </form>
      </div>

      <PostingPreviewRail
        fields={read.card}
        draft={read.draft}
        facts={companyPostingFacts({
          roleKind: read.values.roleKind ?? null,
          openings: fields.vacancies,
          locationNote: fields.locationLabel,
          tradeLevel: showTradeForm ? trade.tradeLevel || null : null,
          tradeAnswers: showTradeForm ? trade.answers : null,
          postingTrades: showTradeForm ? postingTrades : [],
          matchSkills:
            matchSkills.length > 0 ? { ids: activeMatchSkillIds, vocabulary: matchSkills } : null,
          description: fields.description,
        })}
        actions={
          <PostingActions status={statusLine} outcome={outcomeLine}>
            {buttons}
          </PostingActions>
        }
        primary={primary}
        status={statusLine}
        outcome={outcomeLine}
        busy={busy}
      />
    </div>
  );
}
