import { redirect } from "next/navigation";
import { payerAuth } from "../lib/auth";

export const dynamic = "force-dynamic";

/** Root: send a logged-in payer to the dashboard, otherwise to login. */
export default async function Home() {
  const session = await payerAuth().currentSession();
  redirect(session ? "/dashboard" : "/login");
}
