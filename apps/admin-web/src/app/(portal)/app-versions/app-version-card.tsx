"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { CopyId } from "../../../components/copy-id";
import { FieldError } from "../../../components/form-feedback";
import { InlineNotice } from "../../../components/inline-notice";
import { Timestamp } from "../../../components/timestamp";
import { useToast } from "../../../components/toast";
import { successToast } from "../../../components/admin-action-result-banner";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import { shortId } from "../../../lib/format";
import {
  APP_BUILD_NUMBER_MAX,
  APP_RELEASE_FIELDS,
  formValuesFromPolicy,
  lastChange,
  needsRaiseConfirm,
  policyChanges,
  policyTitle,
  raiseConfirmQuestion,
  saveSuccessMessage,
  validateAppReleaseForm,
  type AppReleaseFieldErrors,
  type AppReleaseFieldKey,
  type AppReleaseFormValues,
  type AppReleasePolicy,
  type AppReleasePolicyBody,
  type SaveAppReleasePolicyResult,
} from "../../../lib/app-release-policy-model";
import { saveAppReleasePolicyAction } from "./actions";

function LastChanged({ policy, selfId }: { policy: AppReleasePolicy; selfId: string }) {
  const change = lastChange(policy);
  if (change.kind === "never") return <>Never changed</>;
  const who =
    change.by === selfId ? (
      "you"
    ) : (
      <>
        <span className="mono" title={change.by}>
          {shortId(change.by)}
        </span>
        <CopyId id={change.by} label="admin id" />
      </>
    );
  return (
    <>
      Last changed by {who}
      {change.at ? (
        <>
          {" · "}
          <Timestamp iso={change.at} />
        </>
      ) : null}
    </>
  );
}

/**
 * One app and platform's minimum supported build (#3058): the minimum, the latest build and the
 * store link, saved as ONE row with every field sent and the copy key sent back unchanged.
 *
 * Raising the minimum stops every older install from writing, so a raise asks first, in the
 * shared confirm dialog (no reason: the route stores none). Lowering it, or changing only the
 * latest build or the link, saves at once. Errors sit at their field; a refusal stays in the card.
 */
export function AppVersionCard({ policy, selfId }: { policy: AppReleasePolicy; selfId: string }) {
  const router = useRouter();
  const { show } = useToast();
  const [saved, setSaved] = useState<AppReleasePolicy>(policy);
  const [values, setValues] = useState<AppReleaseFormValues>(() => formValuesFromPolicy(policy));
  const [errors, setErrors] = useState<AppReleaseFieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AppReleasePolicyBody | null>(null);
  const [pending, startTransition] = useTransition();

  const title = policyTitle(saved);
  const base = `app-version-${saved.app}-${saved.platform}`;

  function setValue(key: AppReleaseFieldKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key] && !prev.form) return prev;
      const next = { ...prev };
      delete next[key];
      delete next.form;
      return next;
    });
    setFailure(null);
  }

  /** Apply a save's result to the card; the dialog gets the same answer as an outcome. */
  function settle(result: SaveAppReleasePolicyResult): AdminActionOutcome {
    if (result.ok) {
      setSaved(result.policy);
      setValues(formValuesFromPolicy(result.policy));
      setErrors({});
      setFailure(null);
      const outcome = {
        ok: true as const,
        changed: result.changed,
        message: saveSuccessMessage(result.changed),
      };
      show(successToast(outcome, null));
      router.refresh();
      return outcome;
    }
    setErrors(result.fieldErrors ?? {});
    setFailure(result.error);
    return { ok: false, error: result.error };
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setFailure(null);
    const validation = validateAppReleaseForm(saved, values);
    if (!validation.ok) {
      setErrors(validation.errors);
      const first = APP_RELEASE_FIELDS.find((field) => validation.errors[field.key])?.key;
      if (first && typeof document !== "undefined") {
        document.getElementById(`${base}-${first}`)?.focus();
      }
      return;
    }
    setErrors({});
    if (needsRaiseConfirm(saved, validation.body)) {
      setConfirming(validation.body);
      return;
    }
    const body = validation.body;
    startTransition(async () => {
      settle(await saveAppReleasePolicyAction(body));
    });
  }

  return (
    <section className="panel" aria-labelledby={`${base}-title`}>
      <div className="panel__head">
        <h2 className="panel__title" id={`${base}-title`}>
          {title}
        </h2>
        <p className="panel__sub">
          <LastChanged policy={saved} selfId={selfId} />
        </p>
      </div>

      {failure && !confirming ? (
        <InlineNotice title={`${title} was not saved`}>{failure}</InlineNotice>
      ) : null}
      {errors.form ? (
        <InlineNotice tone="warning" title="Check the values">
          {errors.form}
        </InlineNotice>
      ) : null}

      <form className="form" onSubmit={submit} noValidate aria-busy={pending}>
        <div className="form-grid">
          {APP_RELEASE_FIELDS.map((field) => {
            const id = `${base}-${field.key}`;
            const helpId = `${id}-help`;
            const error = errors[field.key];
            const isLink = field.key === "store_url";
            return (
              <div className="field" key={field.key}>
                <label className="field__label" htmlFor={id}>
                  {field.label}
                </label>
                <input
                  id={id}
                  className="field__input"
                  type={isLink ? "url" : "number"}
                  inputMode={isLink ? "url" : "numeric"}
                  step={isLink ? undefined : 1}
                  min={isLink ? undefined : 0}
                  max={isLink ? undefined : APP_BUILD_NUMBER_MAX}
                  placeholder={isLink ? "https://" : undefined}
                  autoComplete="off"
                  spellCheck={isLink ? false : undefined}
                  value={values[field.key]}
                  onChange={(event) => setValue(field.key, event.target.value)}
                  aria-invalid={error ? "true" : undefined}
                  aria-describedby={error ? `${id}-error ${helpId}` : helpId}
                  disabled={pending}
                />
                <span className="field__help" id={helpId}>
                  {field.help}
                </span>
                <FieldError id={`${id}-error`}>{error}</FieldError>
              </div>
            );
          })}
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn--primary" disabled={pending}>
            <Icon name="floppy-disk" />
            <span>{pending ? "Saving…" : "Save"}</span>
            <span className="sr-only"> {title}</span>
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        tier="consequential"
        askReason={false}
        title={`Raise the minimum build for ${title}`}
        description={
          confirming ? raiseConfirmQuestion(saved, confirming.min_supported_build) : undefined
        }
        changes={confirming ? policyChanges(saved, confirming) : []}
        confirmLabel="Raise minimum"
        onConfirm={async () =>
          confirming
            ? settle(await saveAppReleasePolicyAction(confirming))
            : { ok: false, error: "Nothing to save." }
        }
      />
    </section>
  );
}
