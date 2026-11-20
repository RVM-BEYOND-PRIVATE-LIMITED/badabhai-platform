"use server";

import { z } from "zod";
import { describeAdminActionError } from "../lib/describe-admin-error";
import {
  addManagedInterest,
  removeManagedInterest,
  type AdminManagedOrderDetail,
} from "../lib/managed-hiring";

const noteSchema = z.string().trim().min(15).max(500);

export type ManagedInterestResult =
  | { ok: true; order: AdminManagedOrderDetail }
  | { ok: false; error: string };

export async function addInterestAction(
  orderId: string,
  workerId: string,
  note: string,
): Promise<ManagedInterestResult> {
  if (!noteSchema.safeParse(note).success) {
    return { ok: false, error: "Note must be 15–500 characters." };
  }
  try {
    return { ok: true, order: await addManagedInterest(orderId, workerId, note.trim()) };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function removeInterestAction(
  orderId: string,
  workerId: string,
  reasonText: string,
): Promise<ManagedInterestResult> {
  if (!noteSchema.safeParse(reasonText).success) {
    return { ok: false, error: "Reason must be 15–500 characters." };
  }
  try {
    return { ok: true, order: await removeManagedInterest(orderId, workerId, reasonText.trim()) };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
