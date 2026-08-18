import { PayerTimelineRoute } from "../../../../../components/payer-timeline-route";

export const dynamic = "force-dynamic";
export const metadata = { title: "Company timeline" };

export default async function CompanyTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const cursor = (Array.isArray(sp.cursor) ? sp.cursor[0] : sp.cursor)?.trim() || undefined;
  return <PayerTimelineRoute id={id} kind="Company" cursor={cursor} />;
}
