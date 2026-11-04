import { PayerDetailRoute } from "../../../../components/payer-detail-route";

export const dynamic = "force-dynamic";
// A Company or an Agency (one section since A6, #2576): the page names the kind; the tab says
// what both are — a customer.
export const metadata = { title: "Customer details" };

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PayerDetailRoute id={id} />;
}
