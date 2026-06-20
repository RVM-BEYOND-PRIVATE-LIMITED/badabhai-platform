"use server";

import { redirect } from "next/navigation";
import { payerAuth } from "../../lib/auth";

/** Clear the payer session (server-side) and return to /login. */
export async function logoutAction(): Promise<void> {
  await payerAuth().logout();
  redirect("/login");
}
