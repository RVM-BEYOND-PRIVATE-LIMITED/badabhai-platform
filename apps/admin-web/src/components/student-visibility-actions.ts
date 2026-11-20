"use server";

import { z } from "zod";
import { describeAdminActionError } from "../lib/describe-admin-error";
import {
  setBulkStudentVisibility,
  setStudentVisibility,
  type BulkSelector,
  type MovedStudent,
} from "../lib/students";

const reasonSchema = z.string().trim().min(15).max(500);

export type StudentVisibilityResult =
  | { ok: true; changed: boolean; student?: MovedStudent }
  | { ok: false; error: string };

export type BulkVisibilityResult =
  | { ok: true; changed: number }
  | { ok: false; error: string };

export async function setStudentVisibilityAction(
  workerId: string,
  visible: boolean,
  reasonText: string,
): Promise<StudentVisibilityResult> {
  if (!reasonSchema.safeParse(reasonText).success) {
    return { ok: false, error: "Reason must be 15–500 characters." };
  }
  try {
    const res = await setStudentVisibility(workerId, visible, reasonText.trim());
    return { ok: true, changed: res.changed, student: res.student };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}

export async function setBulkVisibilityAction(
  selector: BulkSelector,
  visible: boolean,
  reasonText: string,
): Promise<BulkVisibilityResult> {
  if (!reasonSchema.safeParse(reasonText).success) {
    return { ok: false, error: "Reason must be 15–500 characters." };
  }
  try {
    return { ok: true, changed: (await setBulkStudentVisibility(selector, visible, reasonText.trim())).changed };
  } catch (err) {
    return { ok: false, error: describeAdminActionError(err) };
  }
}
