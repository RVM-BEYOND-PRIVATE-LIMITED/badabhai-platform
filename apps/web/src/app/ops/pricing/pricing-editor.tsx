"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PricingChange } from "@/lib/api";
import {
  formatCatalogJson,
  parseCatalogJson,
  parseChangedFields,
  isUuid,
  OPS_ACTOR_ID,
} from "@/lib/pricing-view";
import { updateCatalogAction } from "./actions";

/**
 * Catalog editor (ADR-0013). The catalog is large/nested, so this is a pragmatic
 * ALPHA editor: the current catalog is pretty-printed into a textarea, plus the
 * required `change` audit descriptor and the `updated_by` ops-actor id. On submit
 * we guard the JSON client-side (honest parse error) and PUT it; on success the
 * page refreshes to the new revision, on a 400 the server's validation message is
 * shown VERBATIM.
 *
 * There is no ops auth in alpha — `updated_by` is an opaque ops-actor uuid on the
 * body (same posture as job-postings `created_by`). A real `PricingAdminGuard` is
 * a launch gate; this editor does not fake auth.
 */
const CHANGE_TYPES: PricingChange["change_type"][] = ["plan", "discount", "coupon"];

export function PricingEditor({
  initialCatalogJson,
}: {
  initialCatalogJson: string;
}) {
  const router = useRouter();
  const [catalogText, setCatalogText] = useState(initialCatalogJson);
  const [changeType, setChangeType] =
    useState<PricingChange["change_type"]>("plan");
  const [entityCode, setEntityCode] = useState("");
  const [changedFields, setChangedFields] = useState("");
  const [updatedBy, setUpdatedBy] = useState(OPS_ACTOR_ID);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!isUuid(updatedBy)) {
      setError("Enter a valid updated_by ops-actor id (UUID).");
      return;
    }
    if (!entityCode.trim()) {
      setError("Enter the entity_code the change targets.");
      return;
    }

    // Client-side JSON guard — an HONEST parse error before we hit the server. We
    // do NOT validate the catalog SHAPE here; the server's catalogSchema owns that
    // and returns a verbatim 400 we surface below.
    const parsed = parseCatalogJson(catalogText);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    setSubmitting(true);
    const res = await updateCatalogAction({
      updatedBy,
      catalog: parsed.value,
      change: {
        change_type: changeType,
        entity_code: entityCode.trim(),
        changed_fields: parseChangedFields(changedFields),
      },
    });
    setSubmitting(false);

    if (res.ok) {
      // Re-pretty-print from the server's now-active catalog and refresh the page
      // data so the summary table reflects the published revision.
      setCatalogText(formatCatalogJson(res.active.catalog));
      setSuccess(
        `Published revision ${res.active.revision} (source: ${res.active.source}).`,
      );
      setChangedFields("");
      router.refresh();
    } else {
      // The server's 400 validation message, VERBATIM.
      setError(res.error);
    }
  }

  return (
    <form className="form" onSubmit={onSubmit}>
      <p className="note">
        <strong>No ops auth in alpha.</strong> <code>updated_by</code> is an opaque
        ops-actor uuid on the body (same posture as job-postings{" "}
        <code>created_by</code>). A real <code>PricingAdminGuard</code> is a launch
        gate — this editor does not fake auth.
      </p>

      <div className="field">
        <label htmlFor="catalog">
          Catalog (JSON)<span className="req">*</span>
        </label>
        <textarea
          id="catalog"
          className="textarea mono"
          style={{ minHeight: 320 }}
          spellCheck={false}
          value={catalogText}
          onChange={(e) => setCatalogText(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="change_type">
          Change type<span className="req">*</span>
        </label>
        <select
          id="change_type"
          className="select"
          value={changeType}
          onChange={(e) =>
            setChangeType(e.target.value as PricingChange["change_type"])
          }
        >
          {CHANGE_TYPES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="entity_code">
          Entity code<span className="req">*</span>
        </label>
        <input
          id="entity_code"
          className="input mono"
          placeholder="job_posting / pack_10 / launch_promo"
          maxLength={64}
          value={entityCode}
          onChange={(e) => setEntityCode(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="changed_fields">Changed fields (comma-separated)</label>
        <input
          id="changed_fields"
          className="input mono"
          placeholder="priceInr, validityDays"
          value={changedFields}
          onChange={(e) => setChangedFields(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="updated_by">
          Updated by (ops-actor uuid)<span className="req">*</span>
        </label>
        <input
          id="updated_by"
          className="input mono"
          placeholder="00000000-0000-4000-8000-000000000001"
          value={updatedBy}
          onChange={(e) => setUpdatedBy(e.target.value)}
        />
      </div>

      {error ? <p className="error-text">{error}</p> : null}
      {success ? (
        <p className="page-sub">
          <span className="badge">{success}</span>
        </p>
      ) : null}

      <div className="btn-row">
        <button className="btn" type="submit" disabled={submitting}>
          {submitting ? "Publishing…" : "Publish new revision"}
        </button>
      </div>
    </form>
  );
}
