import { CompanyDetailRoute } from "../../../../components/company-detail-route";

export const dynamic = "force-dynamic";
export const metadata = { title: "Company details" };

export default async function CompanyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

  return (
    <CompanyDetailRoute
      id={id}
      tab={one(sp.tab)}
      ledgerCursor={one(sp.ledger)}
      paymentsCursor={one(sp.payments)}
      eventsCursor={one(sp.events)}
    />
  );
}
