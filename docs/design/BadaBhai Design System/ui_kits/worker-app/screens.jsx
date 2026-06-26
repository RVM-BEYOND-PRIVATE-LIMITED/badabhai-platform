/* BadaBhai · Worker mobile app (Flutter product) — screens.
   Composes the design-system primitives from the compiled bundle. */
(function () {
const DS = window.BadaBhaiDesignSystem_01ff85;
const { Button, IconButton, Input, OtpInput, Chip, Badge, Avatar, Card,
        ChatBubble, JobCard, BottomNav, ProgressBar, Switch, Toast, BadaBhaiLogo } = DS;

/* ---------- Device frame ---------- */
function StatusBar({ dark }) {
  return (
    <div className={`wa-status ${dark ? 'wa-status--dark' : ''}`}>
      <span className="wa-status__time">9:41</span>
      <span className="wa-status__icons">
        <i className="ph-fill ph-cell-signal-full"></i>
        <i className="ph-fill ph-wifi-high"></i>
        <i className="ph-fill ph-battery-high"></i>
      </span>
    </div>
  );
}

function DeviceFrame({ children, statusDark }) {
  return (
    <div className="wa-device">
      <div className="wa-device__screen">
        <StatusBar dark={statusDark} />
        {children}
      </div>
    </div>
  );
}

/* ---------- Login (phone → OTP) ---------- */
function LoginScreen({ onDone }) {
  const [step, setStep] = React.useState('phone');
  const [phone, setPhone] = React.useState('98765 43210');
  const [code, setCode] = React.useState('');
  const [lang, setLang] = React.useState('hi');

  return (
    <DeviceFrame>
      <div className="wa-screen wa-login">
        <div className="wa-login__brand">
          <BadaBhaiLogo variant="mark" size={68} />
          <h1 className="wa-login__title">Aapka kaam,<br />bada bhai ke saath.</h1>
          <p className="wa-login__sub">No test. Just talk. Apna profile chat se banayein.</p>
        </div>

        {step === 'phone' ? (
          <div className="wa-login__form">
            <Input label="Phone number" iconLeft="phone" inputMode="tel"
              value={phone} onChange={(e) => setPhone(e.target.value)} />
            <div>
              <div className="wa-login__lang-label">Aap kis bhasha mein baat karein?</div>
              <div className="wa-chips">
                <Chip selected={lang === 'hi'} onClick={() => setLang('hi')}>हिंदी</Chip>
                <Chip selected={lang === 'mr'} onClick={() => setLang('mr')}>मराठी</Chip>
                <Chip selected={lang === 'en'} onClick={() => setLang('en')}>English</Chip>
              </div>
            </div>
            <Button variant="primary" size="lg" block iconRight="arrow-right" onClick={() => setStep('otp')}>
              Continue
            </Button>
            <p className="wa-login__legal">By continuing you agree to our terms &amp; data-use consent, including model training.</p>
          </div>
        ) : (
          <div className="wa-login__form">
            <button className="wa-back" onClick={() => setStep('phone')}><i className="ph ph-arrow-left"></i> Back</button>
            <div className="wa-otp-copy">Enter the 4-digit code we sent to <b>+91 {phone}</b></div>
            <OtpInput length={4} value={code} onChange={setCode} autoFocus />
            <Button variant="primary" size="lg" block onClick={onDone} disabled={code.length < 4}>
              Verify &amp; start
            </Button>
            <button className="wa-link">Resend code in 0:24</button>
          </div>
        )}
      </div>
    </DeviceFrame>
  );
}

/* ---------- Chat onboarding (the front door) ---------- */
const CHAT_SCRIPT = [
  { from: 'bot', text: 'Namaste! 🙏 Main aapka bada bhai. 2 minute baat karein, phir aapka profile aur resume taiyaar.' },
  { from: 'bot', text: 'Aap kaun si machine pe kaam karte hain?' },
  { from: 'user', text: 'CNC operator. Fanuc control.' },
  { from: 'bot', text: 'Badhiya! Kitne saal ka experience hai?' },
  { from: 'user', voice: true, duration: '0:14' },
  { from: 'bot', text: 'Samajh gaya — 6 saal. Pune ke aas-paas kaam dhoond rahe hain?' },
  { from: 'user', text: 'Haan, Pimpri-Chinchwad.' },
  { from: 'bot', text: 'Perfect. Aapka resume ready hai 👍' },
];

function ChatScreen({ onResume }) {
  const [shown, setShown] = React.useState(5);
  const done = shown >= CHAT_SCRIPT.length;
  return (
    <div className="wa-screen wa-chat">
      <div className="wa-appbar">
        <BadaBhaiLogo variant="mark" size={34} />
        <div className="wa-appbar__title">
          <div className="wa-appbar__name">Bada Bhai</div>
          <div className="wa-appbar__status"><span className="wa-dot"></span> online</div>
        </div>
        <IconButton icon="dots-three-vertical" label="More" />
      </div>

      <div className="wa-chat__thread">
        {CHAT_SCRIPT.slice(0, shown).map((m, i) => (
          <ChatBubble key={i} from={m.from} voice={m.voice} duration={m.duration} time={i % 2 ? '9:0' + (i + 1) : undefined}>
            {m.text}
          </ChatBubble>
        ))}
        {done && (
          <div className="wa-chat__cta">
            <Button variant="primary" size="lg" block iconRight="file-text" onClick={onResume}>
              See my resume
            </Button>
          </div>
        )}
      </div>

      <div className="wa-composer">
        <IconButton icon="microphone" label="Voice note" variant="solid" size="lg" />
        <div className="wa-composer__input">Type or hold mic to talk…</div>
        {!done
          ? <IconButton icon="paper-plane-right" label="Send" variant="solid" size="lg" onClick={() => setShown((s) => Math.min(s + 1, CHAT_SCRIPT.length))} />
          : <IconButton icon="paper-plane-right" label="Send" size="lg" />}
      </div>
    </div>
  );
}

/* ---------- Resume ready ---------- */
function ResumeScreen({ onExplore }) {
  return (
    <div className="wa-screen wa-resume">
      <div className="wa-resume__hero">
        <div className="wa-stamp"><i className="ph-bold ph-check"></i></div>
        <h2>Resume ready!</h2>
        <p>Ek branded, share-ready resume — bilkul free.</p>
      </div>

      <Card className="wa-resume__doc" padding="none">
        <div className="wa-resume__docTop">
          <div>
            <div className="wa-resume__name">Ramesh Kumar</div>
            <div className="wa-resume__role">CNC Operator · 6 years</div>
          </div>
          <BadaBhaiLogo variant="mark" size={30} />
        </div>
        <div className="wa-resume__section">
          <div className="wa-resume__h">Skills</div>
          <div className="wa-chips">
            <span className="bb-badge bb-badge--neutral">Fanuc control</span>
            <span className="bb-badge bb-badge--neutral">VMC setting</span>
            <span className="bb-badge bb-badge--neutral">GD&amp;T reading</span>
            <span className="bb-badge bb-badge--neutral">Quality check</span>
          </div>
        </div>
        <div className="wa-resume__section">
          <div className="wa-resume__h">Experience</div>
          <div className="wa-resume__exp"><b>Operator</b> · Kalyani Industries · 2020–now</div>
          <div className="wa-resume__exp"><b>Trainee</b> · MIDC Bhosari · 2018–2020</div>
        </div>
        <div className="wa-resume__watermark">Made with BadaBhai</div>
      </Card>

      <div className="wa-resume__actions">
        <Button variant="primary" size="lg" block iconLeft="download-simple">Download PDF</Button>
        <Button variant="success" size="lg" block iconLeft="whatsapp-logo">Share on WhatsApp</Button>
      </div>
      <p className="wa-resume__note">Naam, photo aur phone aap control karte hain — Profile mein badlein.</p>
      {onExplore && (
        <Button variant="secondary" size="lg" block iconRight="arrow-right" className="wa-resume__explore" onClick={onExplore}>
          Explore jobs near me
        </Button>
      )}
    </div>
  );
}

/* ---------- Job feed (swipe-to-apply) ---------- */
const JOBS = [
  { title: 'CNC Operator', company: 'Sharma Precision Works', location: 'Pimpri, Pune', shift: 'Day shift', salary: '₹22,000–28,000 / mo', tags: ['Fanuc control', '2+ yrs', 'PF + ESI'], vacanciesLeft: 4 },
  { title: 'VMC Setter', company: 'Deccan Auto Components', location: 'Chakan, Pune', shift: 'Rotational', salary: '₹26,000–32,000 / mo', tags: ['VMC', 'Setting', '4+ yrs'], vacanciesLeft: 2 },
  { title: 'Quality Inspector', company: 'Bharat Forge Vendor', location: 'Bhosari, Pune', shift: 'General', salary: '₹20,000–24,000 / mo', tags: ['GD&T', 'CMM', '1+ yr'], vacanciesLeft: 6 },
];

function FeedScreen() {
  const [idx, setIdx] = React.useState(0);
  const [applied, setApplied] = React.useState(0);
  const [toast, setToast] = React.useState(null);
  const job = JOBS[idx % JOBS.length];

  const next = (didApply) => {
    if (didApply) { setApplied((a) => a + 1); setToast('applied'); }
    else setToast('skipped');
    setTimeout(() => setToast(null), 1600);
    setIdx((i) => i + 1);
  };

  return (
    <div className="wa-screen wa-feed">
      <div className="wa-appbar wa-appbar--feed">
        <div>
          <div className="wa-feed__eyebrow">Jobs near you</div>
          <div className="wa-feed__loc"><i className="ph-fill ph-map-pin"></i> Pune · 15 km</div>
        </div>
        <IconButton icon="sliders-horizontal" label="Filters" variant="outline" />
      </div>

      <div className="wa-chips wa-feed__filters">
        <Chip icon="wrench" selected>CNC</Chip>
        <Chip icon="wrench">VMC</Chip>
        <Chip icon="shield-check">Verified</Chip>
        <Chip icon="clock">Day shift</Chip>
      </div>

      <div className="wa-feed__deck">
        <div className="wa-feed__behind wa-feed__behind2"></div>
        <div className="wa-feed__behind wa-feed__behind1"></div>
        <JobCard key={idx} {...job} onApply={() => next(true)} onSkip={() => next(false)} />
      </div>

      <div className="wa-feed__hint"><i className="ph ph-hand-swipe-left"></i> Skip · Apply <i className="ph ph-hand-swipe-right"></i></div>

      {toast && (
        <div className="wa-toast-host">
          <Toast tone={toast === 'applied' ? 'success' : 'neutral'} title={toast === 'applied' ? 'Applied!' : 'Skipped'}>
            {toast === 'applied' ? 'Employer ko bata diya. ' + applied + ' applied today.' : 'Agla job dikha rahe hain.'}
          </Toast>
        </div>
      )}
    </div>
  );
}

/* ---------- Profile ---------- */
function ProfileScreen() {
  return (
    <div className="wa-screen wa-profile">
      <div className="wa-appbar"><div className="wa-appbar__name wa-appbar__name--lg">Profile</div></div>
      <div className="wa-profile__head">
        <Avatar name="Ramesh Kumar" size={72} brand verified />
        <div>
          <div className="wa-profile__name">Ramesh Kumar</div>
          <div className="wa-profile__role">CNC Operator · Pune</div>
          <span className="bb-badge bb-badge--success" style={{ marginTop: 6 }}><i className="ph-fill ph-seal-check"></i> Verified</span>
        </div>
      </div>

      <Card className="wa-card">
        <ProgressBar value={72} label="Profile strength" showValue />
        <p className="wa-muted" style={{ marginTop: 10 }}>Add a photo to reach 100% and get seen more.</p>
      </Card>

      <Card className="wa-card">
        <div className="wa-card__h">What employers can see</div>
        <div className="wa-toggles">
          <Switch defaultChecked label="Show my phone to verified employers" />
          <Switch defaultChecked label="Show my photo" />
          <Switch label="Open to night shift" />
        </div>
      </Card>

      <Card className="wa-card wa-kit" interactive>
        <div className="wa-kit__icon"><i className="ph-fill ph-exam"></i></div>
        <div style={{ flex: 1 }}>
          <div className="wa-card__h">CNC interview kit</div>
          <div className="wa-muted">15 common questions + answers</div>
        </div>
        <i className="ph ph-download-simple wa-kit__dl"></i>
      </Card>
    </div>
  );
}

Object.assign(window, { DeviceFrame, LoginScreen, ChatScreen, ResumeScreen, FeedScreen, ProfileScreen });
})();
