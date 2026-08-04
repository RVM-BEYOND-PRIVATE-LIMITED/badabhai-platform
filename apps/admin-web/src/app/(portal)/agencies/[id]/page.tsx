import { PayerDetailRoute } from "../../../../components/payer-detail-route";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agency" };

export default async function AgencyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PayerDetailRoute id={id} kind="Agency" />;
}
