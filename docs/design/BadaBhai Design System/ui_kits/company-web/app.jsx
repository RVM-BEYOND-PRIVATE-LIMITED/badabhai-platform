(function () {
const { Toast } = window.BadaBhaiDesignSystem_01ff85;

/* Role-aware controller. Company & Agency share the demand loop; Agency adds a
   parked Earnings view (supply dashboard is the post-alpha fast-follow). */
function CompanyWebApp() {
  const [role, setRole] = React.useState('company');
  const [view, setView] = React.useState('dashboard');
  const [credits, setCredits] = React.useState(184);
  const [unlocked, setUnlocked] = React.useState(() => new Set());
  const [postedToast, setPostedToast] = React.useState(false);

  const handleUnlock = (id) => {
    setUnlocked((prev) => { const n = new Set(prev); n.add(id); return n; });
    setCredits((c) => Math.max(0, c - 1));
  };
  const handleRole = (r) => {
    setRole(r);
    if (r === 'company' && view === 'earnings') setView('dashboard');
  };
  const handlePosted = () => {
    setView('jobs');
    setPostedToast(true);
    setTimeout(() => setPostedToast(false), 2400);
  };

  let content = null;
  if (view === 'dashboard') content = <window.DashboardView setView={setView} />;
  else if (view === 'candidates') content = <window.CandidatesView credits={credits} unlocked={unlocked} onUnlock={handleUnlock} />;
  else if (view === 'jobs') content = <window.JobsView setView={setView} />;
  else if (view === 'post') content = <window.PostJobView onPosted={handlePosted} />;
  else if (view === 'earnings') content = <window.EarningsView />;

  return (
    <React.Fragment>
      <window.WebShell role={role} setRole={handleRole} view={view} setView={setView} credits={credits}>
        {content}
      </window.WebShell>
      {postedToast && (
        <div className="cw-toast">
          <Toast tone="brand" title="Submitted for verification" onClose={() => setPostedToast(false)}>
            We'll confirm the job is real and publish within a few hours.
          </Toast>
        </div>
      )}
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<CompanyWebApp />);
})();
