import Link from "next/link";

/**
 * Workers table — PLACEHOLDER. Data wiring (API: GET /workers, /workers/:id/profile)
 * is a later slice. Sample rows are clearly synthetic.
 */
const SAMPLE = [
  { id: "00000000-0000-4000-8000-000000000001", status: "active", role: "role_vmc_operator", profile: "confirmed" },
  { id: "00000000-0000-4000-8000-000000000002", status: "active", role: "role_cnc_turner_operator", profile: "extracted" },
];

export default function WorkersPage() {
  return (
    <>
      <h1 className="page-title">Workers</h1>
      <p className="page-sub">
        Profiled workers. <span className="badge">Placeholder data</span>
      </p>

      <table>
        <thead>
          <tr>
            <th>Worker ID</th>
            <th>Status</th>
            <th>Canonical role</th>
            <th>Profile</th>
          </tr>
        </thead>
        <tbody>
          {SAMPLE.map((w) => (
            <tr key={w.id}>
              <td>
                <Link href={`/ops/workers/${w.id}`}>{w.id}</Link>
              </td>
              <td>{w.status}</td>
              <td>{w.role}</td>
              <td>{w.profile}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="footer">TODO: wire to the API (no PII — phone/name are not shown here).</div>
    </>
  );
}
