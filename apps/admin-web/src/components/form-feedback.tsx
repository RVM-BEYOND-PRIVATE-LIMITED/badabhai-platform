"use client";

import { useRef, useState, type ReactNode } from "react";

export type FormErrors<K extends string> = Partial<Record<K, string>>;

export interface UseFormValidationOptions<K extends string> {
  /** The errors for the CURRENT values. Called on every render; validation timing is ours. */
  validate: () => FormErrors<K>;
  /** Field order, used for focus and the summary links. */
  order: readonly K[];
  /** Called with the first invalid field on submit. */
  focus?: (field: K) => void;
  /** The DOM id used for each field; the summary links to it. Defaults to the field name. */
  fieldId?: (field: K) => string;
}

/**
 * Inline-validation timing for the admin forms (#2689 rule 1).
 *
 * A first edit never shows an error. A field starts reporting after it is blurred or after the
 * form is submitted; from then on the error is derived from the current value on every render, so
 * it clears the moment the value is fixed. On submit the first invalid field is focused and the
 * form shakes once.
 */
export function useFormValidation<K extends string>({
  validate,
  order,
  focus,
  fieldId,
}: UseFormValidationOptions<K>) {
  const [touched, setTouched] = useState<ReadonlySet<K>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [shaking, setShaking] = useState(false);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const errors = validate();
  const visible: { field: string; message: string }[] = [];
  for (const field of order) {
    const message = errors[field];
    if (message && (submitted || touched.has(field)))
      visible.push({ field: fieldId?.(field) ?? field, message });
  }
  const visibleErrors: FormErrors<K> = {};
  for (const field of order) {
    const message = errors[field];
    if (message && (submitted || touched.has(field))) visibleErrors[field] = message;
  }

  function onBlur(field: K) {
    setTouched((prev) => {
      if (prev.has(field)) return prev;
      const next = new Set(prev);
      next.add(field);
      return next;
    });
  }

  function shake() {
    if (shakeTimer.current) clearTimeout(shakeTimer.current);
    setShaking(true);
    shakeTimer.current = setTimeout(() => setShaking(false), 240);
  }

  /**
   * Marks the form submitted and returns the first invalid field, or null when it may go ahead.
   * The caller decides whether to call the server action.
   */
  function submit(): K | null {
    setSubmitted(true);
    const first = order.find((field) => Boolean(errors[field])) ?? null;
    if (!first) return null;
    shake();
    focusRef.current?.(first);
    return first;
  }

  function reset() {
    setTouched(new Set());
    setSubmitted(false);
    setShaking(false);
  }

  return {
    errors: visibleErrors,
    allErrors: errors,
    visible,
    onBlur,
    submit,
    reset,
    shaking,
    submitted,
    /** True once at least one field has been blurred or the form submitted. */
    armed: submitted || touched.size > 0,
  };
}

/** A field's one-line fix, revealed with the shared 4px slide/fade. */
export function FieldError({ id, children }: { id?: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="field__error field__error--in" id={id}>
      {children}
    </p>
  );
}

/**
 * The slim line above a form when several fields need attention (#2689 rule 1). Each item is a
 * link to the field, so the operator can jump straight to it.
 */
export function FormSummary({
  errors,
  id = "form-summary",
}: {
  errors: readonly { field: string; message: string }[];
  id?: string;
}) {
  if (errors.length < 2) return null;
  return (
    <p className="form__summary" id={id} role="status" aria-live="polite">
      <strong>{errors.length} fields need attention.</strong>{" "}
      {errors.map((error, index) => (
        <span key={error.field}>
          {index > 0 ? " · " : null}
          <a className="link" href={`#${error.field}`}>
            {error.message}
          </a>
        </span>
      ))}
    </p>
  );
}
