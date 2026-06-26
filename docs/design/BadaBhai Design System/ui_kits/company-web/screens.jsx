/* BadaBhai · Company / Agency web app (Next.js product) — screens.
   Role-aware demand loop: post → browse masked → unlock → contact. */
(function () {
const DS = window.BadaBhaiDesignSystem_01ff85;
const { Button, IconButton, Input, Textarea, Select, Badge, Card, Tabs, Dialog,
        Avatar, StatTile, MaskedCandidate, ProgressBar, Toast, BadaBhaiLogo, Chip } = DS;

const ACCOUNT = {
  company: { name: 'Kalyani Industries', plan: 'Company account' },
  agency: { name: 'Apex Staffing', plan: 'Agency · supply + demand' },
};

const CANDIDATES = [
  { id: 1, name: 'Ramesh Kumar', trade: 'CNC Operator', experience: '6 yrs', location: 'Pimpri, Pune', matchLabel: 'Strong match' },
  { id: 2, name: 'Suresh Patil', trade: 'VMC Setter', experience: '4 yrs', location: 'Chakan, Pune' },
  { id: 3, name: 'Imran Shaikh', trade: 'CNC Operator', experience: '8 yrs', location: 'Bhosari, Pune', matchLabel: 'Strong match' },
  { id: 4, name: 'Vikas More', trade: 'Quality Inspector', experience: '3 yrs', location: 'Hadapsar, Pune' },
  { id: 5, name: 'Ganesh Jadhav', trade: 'CNC Operator', experience: '2 yrs', location: 'Wagholi, Pune' },
];

const JOBS = [
  { title: 'CNC Operator', band: '5–10 vacancies', filled: 7, quota: 10, status: 'live', applicants: 23 },
  { title: 'VMC Setter', band: '1 vacancy', filled: 1, quota: 1, status: 'filled', applicants: 9 },
  { title: 'Quality Inspector', band: '2–4 vacancies', filled: 1, quota: 4, status: 'review', applicants: 0 },
];

/* ---------- Shell ---------- */
function WebShell({ role, setRole, view, setView, credits, children }) {
  const nav = [
    { id: 'dashboard', label: 'Dashboard', icon: 'gauge' },
    { id: 'candidates', label: 'Find candidates', icon: 'magnifying-glass' },
    { id: 'jobs', label: 'My jobs', icon: 'briefcase' },
    { id: 'post', label: 'Post a job', icon: 'plus-circle' },
  ];
  if (role === 'agency') nav.push({ id: 'earnings', label: 'Earnings', icon: 'wallet' });
  const titles = { dashboard: 'Dashboard', candidates: 'Find candidates', jobs: 'My jobs', post: 'Post a job', earnings: 'Agency earnings' };
  const acct = ACCOUNT[role];

  return (
    <div className="cw">
      <aside className="cw-side" data-theme="ink">
        <div className="cw-side__brand"><BadaBhaiLogo theme="ink" size={26} /></div>
        <nav className="cw-side__nav">
          {nav.map((n) => (
            <button key={n.id} className={`cw-navitem ${view === n.id ? 'cw-navitem--active' : ''}`} onClick={() => setView(n.id)}>
              <i className={`${view === n.id ? 'ph-fill' : 'ph'} ph-${n.icon}`} aria-hidden="true"></i>
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="cw-acct">
          <Avatar name={acct.name} size={36} brand />
          <div className="cw-acct__text">
            <div className="cw-acct__name">{acct.name}</div>
            <div className="cw-acct__plan">{acct.plan}</div>
          </div>
        </div>
      </aside>

      <div className="cw-main">
        <header className="cw-top">
          <h1 className="cw-top__title">{titles[view]}</h1>
          <div className="cw-top__right">
            <div className="cw-credits"><i className="ph-fill ph-lock-key-open" aria-hidden="true"></i><b>{credits}</b> unlocks</div>
            <Tabs variant="segmented" value={role} onChange={setRole} tabs={[{ id: 'company', label: 'Company' }, { id: 'agency', label: 'Agency' }]} />
            <IconButton icon="bell" label="Notifications" variant="outline" />
          </div>
        </header>
        <main className="cw-content">{children}</main>
      </div>
    </div>
  );
}

/* ---------- Dashboard ---------- */
function DashboardView({ setView }) {
  return (
    <div className="cw-stack">
      <div className="cw-stats">
        <StatTile label="Paid unlocks this week" value="1,284" icon="lock-key-open" delta="+12% vs last" deltaDir="up" />
        <StatTile label="Repeat-unlock rate" value="62%" icon="repeat" delta="health metric" deltaDir="flat" />
        <StatTile label="Active jobs" value="7" icon="briefcase" delta="2 near quota" deltaDir="up" />
        <StatTile label="Avg reply time" value="3.4h" icon="chat-circle-dots" delta="−18%" deltaDir="down" />
      </div>

      <div className="cw-grid2">
        <Card>
          <div className="cw-card__head"><h3>Recent activity</h3><Button variant="ghost" size="sm" onClick={() => setView('candidates')}>Find candidates</Button></div>
          <ul className="cw-activity">
            <li><span className="cw-act__icon cw-act__icon--green"><i className="ph-fill ph-lock-key-open"></i></span><div><b>Unlocked</b> Ramesh K. · CNC Operator<span className="cw-act__time">12 min ago</span></div></li>
            <li><span className="cw-act__icon cw-act__icon--brand"><i className="ph-fill ph-hand-swipe-right"></i></span><div><b>9 new applicants</b> on VMC Setter<span className="cw-act__time">1 hr ago</span></div></li>
            <li><span className="cw-act__icon cw-act__icon--amber"><i className="ph-fill ph-warning"></i></span><div><b>CNC Operator</b> is 70% to quota<span className="cw-act__time">2 hr ago</span></div></li>
          </ul>
        </Card>

        <Card variant="ink" className="cw-topup">
          <div className="cw-topup__h">Top up unlocks</div>
          <p className="cw-topup__p">Each contact unlock is ₹40 flat. Buy in bulk — the 1,000-pack carries a real discount.</p>
          <div className="cw-packs">
            <button className="cw-pack"><b>50</b><span>₹2,000</span></button>
            <button className="cw-pack"><b>200</b><span>₹7,600</span></button>
            <button className="cw-pack cw-pack--best"><span className="cw-pack__tag">Best value</span><b>1,000</b><span>₹34,000</span></button>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------- Find candidates (the demand loop) ---------- */
function CandidatesView({ credits, unlocked, onUnlock }) {
  const [pending, setPending] = React.useState(null);
  const [toast, setToast] = React.useState(false);
  const [trade, setTrade] = React.useState('cnc');

  const confirm = () => {
    onUnlock(pending.id);
    setPending(null);
    setToast(true);
    setTimeout(() => setToast(false), 1800);
  };

  return (
    <div className="cw-stack">
      <div className="cw-searchbar">
        <div className="cw-searchbar__input"><Input iconLeft="magnifying-glass" placeholder="Search trade, skill, or location…" /></div>
        <Select value={trade} onChange={(e) => setTrade(e.target.value)}>
          <option value="cnc">CNC Operator</option>
          <option value="vmc">VMC Setter</option>
          <option value="qc">Quality Inspector</option>
        </Select>
        <Button variant="secondary" iconLeft="sliders-horizontal">Filters</Button>
      </div>

      <div className="cw-chips">
        <Chip icon="map-pin" selected>Pune · 25 km</Chip>
        <Chip icon="shield-check" selected>Verified</Chip>
        <Chip icon="medal">3+ yrs</Chip>
        <Chip icon="clock">Available now</Chip>
      </div>

      <div className="cw-resultmeta"><b>{CANDIDATES.length}</b> verified candidates · sorted by relevance, never by who paid</div>

      <div className="cw-candlist">
        {CANDIDATES.map((c) => (
          <MaskedCandidate
            key={c.id}
            name={c.name}
            trade={c.trade}
            experience={c.experience}
            location={c.location}
            matchLabel={c.matchLabel}
            masked={!unlocked.has(c.id)}
            onUnlock={() => setPending(c)}
          />
        ))}
      </div>

      <Dialog
        open={!!pending}
        onClose={() => setPending(null)}
        title="Unlock this candidate?"
        footer={<React.Fragment>
          <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
          <Button variant="primary" iconLeft="lock-key-open" onClick={confirm}>Unlock for ₹40</Button>
        </React.Fragment>}
      >
        You'll see their name and phone number. One unlock credit will be used
        ({credits} left). Unlocking only reveals contact — it never changes a worker's ranking.
      </Dialog>

      {toast && <div className="cw-toast"><Toast tone="success" title="Unlocked!">Contact details are now visible. Reach out within the app.</Toast></div>}
    </div>
  );
}

/* ---------- My jobs ---------- */
function JobsView({ setView }) {
  const statusBadge = {
    live: <Badge tone="success" icon="circle">Live</Badge>,
    filled: <Badge tone="neutral" upper>Filled</Badge>,
    review: <Badge tone="warning" icon="clock">In review</Badge>,
  };
  return (
    <div className="cw-stack">
      <div className="cw-rowhead">
        <span>{JOBS.length} jobs</span>
        <Button variant="primary" iconLeft="plus" onClick={() => setView('post')}>Post a job</Button>
      </div>
      <div className="cw-joblist">
        {JOBS.map((j, i) => (
          <Card key={i} className="cw-jobrow">
            <div className="cw-jobrow__main">
              <div className="cw-jobrow__title">{j.title} {statusBadge[j.status]}</div>
              <div className="cw-jobrow__meta">{j.band} · {j.applicants} applicants</div>
              <div className="cw-jobrow__bar"><ProgressBar value={(j.filled / j.quota) * 100} tone={j.status === 'filled' ? 'success' : 'brand'} label={`Applicant quota · ${j.filled}/${j.quota}`} showValue /></div>
            </div>
            <div className="cw-jobrow__actions">
              <Button variant="secondary" iconLeft="users-three" disabled={j.applicants === 0}>Applicants</Button>
              <IconButton icon="dots-three" label="More" variant="outline" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ---------- Post a job ---------- */
function PostJobView({ onPosted }) {
  return (
    <div className="cw-postwrap">
      <Card className="cw-form">
        <Input label="Job title" placeholder="e.g. CNC Operator" defaultValue="CNC Operator" />
        <div className="cw-form__row">
          <Select label="Trade family"><option>CNC / VMC machining</option><option>Welding & fabrication</option><option>Quality & inspection</option></Select>
          <Select label="Vacancy band" hint="Small bands stay free"><option>1 vacancy</option><option>2–4 vacancies</option><option>5–10 vacancies</option><option>10+ vacancies</option></Select>
        </div>
        <div className="cw-form__row">
          <Input label="Location" iconLeft="map-pin" defaultValue="Pimpri-Chinchwad, Pune" />
          <Input label="Monthly salary" iconLeft="currency-inr" defaultValue="22,000 – 28,000" />
        </div>
        <Textarea label="What will they do?" rows={4} defaultValue="Operate Fanuc CNC, load programs, run quality checks, maintain output." />
        <div className="cw-verify"><i className="ph-fill ph-shield-check"></i><div><b>Verification-gated.</b> We confirm this job is real before workers see it — ghost jobs waste swipes and erode trust. Posting is free through launch.</div></div>
        <div className="cw-form__foot">
          <Button variant="ghost">Save draft</Button>
          <Button variant="primary" iconLeft="paper-plane-right" onClick={onPosted}>Submit for verification</Button>
        </div>
      </Card>
    </div>
  );
}

/* ---------- Agency earnings (parked / fast-follow) ---------- */
function EarningsView() {
  return (
    <div className="cw-empty">
      <div className="cw-empty__icon"><i className="ph ph-wallet"></i></div>
      <h2>Supply dashboard is coming soon</h2>
      <p>Referral links, payouts, KYC and the 25% rev-share engine are the first
      fast-follow after alpha. For now, the Agency uses the same demand loop as a
      Company — post jobs and unlock candidates.</p>
      <Badge tone="warning" upper>Fast-follow · post-alpha</Badge>
    </div>
  );
}

Object.assign(window, { WebShell, DashboardView, CandidatesView, JobsView, PostJobView, EarningsView });
})();
