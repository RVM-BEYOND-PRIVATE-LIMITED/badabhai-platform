/* BadaBhai · Worker App (Android build kit) — all screens.
   Self-contained (no design-system bundle); reads brand tokens from styles.css. */
(function () {

// Inline logo so the kit works as a single file (file://, bundled, or over HTTP).
var LOGO_SRC = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Crect width='512' height='512' rx='128' fill='%23E0371C'/%3E%3Cpath d='M150 124h212a40 40 0 0 1 40 40v132a40 40 0 0 1-40 40H252l-78 62a12 12 0 0 1-19.4-9.4V336h-4.6a40 40 0 0 1-40-40V164a40 40 0 0 1 40-40Z' fill='%23ffffff'/%3E%3Cpath d='M196 268l60-58 60 58' stroke='%230E7A4F' stroke-width='32' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E";

function Logo({ size = 40, text = 22, wordmark = true }) {
  return (
    <span className="aw-logo" style={{ '--lz': size + 'px', '--lt': text + 'px' }}>
      <img src={LOGO_SRC} alt="" />
      {wordmark && <b>Bada<span className="v">Bhai</span></b>}
    </span>
  );
}

function Device({ children, dark }) {
  return (
    <div className="aw-phone"><div className="aw-screen">
      <div className={'aw-status' + (dark ? ' is-dark' : '')}>
        <span>9:41</span>
        <span className="i"><i className="ph-fill ph-cell-signal-full"></i><i className="ph-fill ph-wifi-high"></i><i className="ph-fill ph-battery-high"></i></span>
      </div>
      {children}
    </div></div>
  );
}

function Nav({ tab, go }) {
  const items = [['feed', 'Jobs', 'briefcase'], ['resume', 'Resume', 'file-text'], ['profile', 'Profile', 'user'], ['notifications', 'Alerts', 'bell']];
  return (
    <div className="aw-nav">
      {items.map(([id, l, ic]) => (
        <button key={id} className={tab === id ? 'is-on' : ''} onClick={() => go(id)}>
          <i className={(tab === id ? 'ph-fill' : 'ph') + ' ph-' + ic}></i>
          {id === 'notifications' && <span className="aw-nav__badge">2</span>}
          {l}
        </button>
      ))}
    </div>
  );
}

/* 01 · Splash + language */
function Splash({ go }) {
  const [lang, setLang] = React.useState('hi');
  const L = [['hi', 'हिंदी', 'Hindi'], ['mr', 'मराठी', 'Marathi'], ['bho', 'भोजपुरी', 'Bhojpuri'], ['en', 'English', 'English']];
  return (
    <Device>
      <div className="aw-splash">
        <div className="aw-splash__hero">
          <Logo size={72} wordmark={false} />
          <h1>Aapka kaam,<br />bada bhai ke saath.</h1>
          <p>No test. Just talk.</p>
        </div>
        <div>
          <div className="aw-label">Aap kis bhasha mein baat karein?</div>
          <div className="aw-langgrid">
            {L.map(([id, big, sub]) => (
              <button key={id} className={'aw-lang' + (lang === id ? ' is-on' : '')} onClick={() => setLang(id)}>
                <span>{big}<small>{sub}</small></span>
                {lang === id && <i className="ph-fill ph-check-circle"></i>}
              </button>
            ))}
          </div>
          <button className="aw-btn aw-btn--brand" onClick={() => go('phone')}>Chalo shuru karein <i className="ph-bold ph-arrow-right"></i></button>
        </div>
      </div>
    </Device>
  );
}

/* 02 · Phone */
function Phone({ go }) {
  return (
    <Device>
      <div className="aw-bar"><button className="aw-back" onClick={() => go('splash')}><i className="ph ph-arrow-left"></i></button></div>
      <div className="aw-body aw-pad">
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, margin: '6px 0 8px', color: 'var(--text-primary)' }}>Apna number daalein</h1>
        <p className="aw-muted" style={{ marginBottom: 22 }}>Hum ek OTP bhejenge. Aapka number kisi employer ko nahi dikhta jab tak aap na chaahein.</p>
        <label className="aw-label">Phone number</label>
        <div style={{ display: 'flex', gap: 10, marginBottom: 22 }}>
          <div className="aw-input" style={{ width: 78, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>+91</div>
          <input className="aw-input" defaultValue="98765 43210" inputMode="tel" />
        </div>
        <button className="aw-btn aw-btn--brand" onClick={() => go('otp')}>OTP bhejein <i className="ph-bold ph-arrow-right"></i></button>
      </div>
    </Device>
  );
}

/* 03 · OTP */
function Otp({ go }) {
  const d = ['9', '4', '', ''];
  return (
    <Device>
      <div className="aw-bar"><button className="aw-back" onClick={() => go('phone')}><i className="ph ph-arrow-left"></i></button></div>
      <div className="aw-body aw-pad">
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800, margin: '6px 0 8px', color: 'var(--text-primary)' }}>Code daalein</h1>
        <p className="aw-muted" style={{ marginBottom: 26 }}>+91 98765 43210 par bheja gaya 4-digit code.</p>
        <div className="aw-otp" style={{ marginBottom: 24 }}>{d.map((c, i) => <span key={i} className={c ? 'on' : ''}>{c}</span>)}</div>
        <button className="aw-btn aw-btn--brand" onClick={() => go('consent')}>Verify &amp; aage badhein</button>
        <p style={{ textAlign: 'center', marginTop: 16 }}><button className="aw-linkbtn">Code dobara bhejein · 0:24</button></p>
      </div>
    </Device>
  );
}

/* 04 · Consent (DPDP) */
function Consent({ go }) {
  const rows = [
    ['chat-circle-dots', 'Chat se profile', 'Bada bhai aapse baat karke profile banata hai — koi form nahi.'],
    ['shield-check', 'Aapka data, aapke India mein', 'Sab kuch Mumbai ke servers par. Aap kabhi bhi delete kar sakte hain.'],
    ['brain', 'Behtar madad ke liye', 'Aapki baat-cheet se hamara AI seekhta hai (model training).'],
  ];
  return (
    <Device>
      <div className="aw-bar"><button className="aw-back" onClick={() => go('otp')}><i className="ph ph-arrow-left"></i></button><div className="aw-bar__t"><div className="aw-bar__title">Sahmati</div></div></div>
      <div className="aw-body aw-pad">
        {rows.map(([ic, t, p]) => (
          <div className="aw-consent__row" key={t}><i className={'ph-fill ph-' + ic}></i><div><b>{t}</b><p>{p}</p></div></div>
        ))}
        <p className="aw-legal" style={{ margin: '18px 0' }}>Aage badhne par aap hamari Terms &amp; data-use consent (incl. model training) se sahmat hain. DPDP ke tahat surakshit.</p>
        <button className="aw-btn aw-btn--go" onClick={() => go('chat')}><i className="ph-bold ph-check"></i> Main sahmat hoon</button>
      </div>
    </Device>
  );
}

/* 05 · Chat onboarding */
function Chat({ go }) {
  const msgs = [
    ['bot', 'Namaste! 🙏 Main aapka bada bhai. 2 minute baat karein, phir profile aur resume taiyaar.'],
    ['bot', 'Aap kaun si machine pe kaam karte hain?'],
    ['me', 'CNC operator. Fanuc control.'],
    ['bot', 'Badhiya! Kitne saal ka experience hai?'],
    ['voice', '0:14'],
  ];
  return (
    <Device>
      <div className="aw-bar">
        <Logo size={34} wordmark={false} />
        <div className="aw-bar__t"><div className="aw-bar__title" style={{ fontSize: 18 }}>Bada Bhai</div><div className="aw-bar__sub"><span className="aw-dot"></span> online</div></div>
        <button className="aw-iconbtn"><i className="ph ph-dots-three-vertical"></i></button>
      </div>
      <div className="aw-body">
        <div className="aw-chat">
          {msgs.map((m, i) => m[0] === 'voice' ? (
            <div className="aw-msg aw-msg--me" key={i}><div className="aw-bub"><div className="aw-voice"><span className="aw-voice__play"><i className="ph-fill ph-play"></i></span><span className="aw-wave">{[10, 16, 8, 20, 12, 18, 7, 14, 9].map((h, j) => <i key={j} style={{ height: h }}></i>)}</span><span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{m[1]}</span></div></div></div>
          ) : (
            <div className={'aw-msg aw-msg--' + m[0]} key={i}>{m[0] === 'bot' && <img className="aw-msg__av" src={LOGO_SRC} alt="" />}<div className="aw-bub">{m[1]}</div></div>
          ))}
          <div className="aw-pop">
            <div className="aw-pop__h"><i className="ph-fill ph-magic-wand"></i> Yeh sahi hai? (tap to edit)</div>
            <div className="aw-pop__field"><b>Trade</b><span>CNC Operator</span></div>
            <div className="aw-pop__field"><b>Experience</b><span>6 saal</span></div>
            <div className="aw-pop__field"><b>Location</b><span>Pimpri-Chinchwad</span></div>
            <button className="aw-btn aw-btn--go aw-btn--sm" style={{ width: '100%', marginTop: 12 }} onClick={() => go('building')}>Haan, resume banao</button>
          </div>
        </div>
      </div>
      <div className="aw-composer">
        <button className="aw-mic"><i className="ph-fill ph-microphone"></i></button>
        <div className="aw-composer__in">Type ya mic dabaa ke boliye…</div>
        <button className="aw-mic" style={{ background: 'var(--surface-sunken)', color: 'var(--text-muted)' }}><i className="ph ph-paper-plane-right"></i></button>
      </div>
    </Device>
  );
}

/* 06 · Building */
function Building({ go, live }) {
  React.useEffect(() => { if (!live) return; const t = setTimeout(() => go('resume'), 1800); return () => clearTimeout(t); }, [live]);
  return (
    <Device>
      <div className="aw-build">
        <div className="aw-spin"></div>
        <h2>Resume ban raha hai…</h2>
        <p className="aw-muted">Aapki baat se ek branded, share-ready resume taiyaar kar rahe hain.</p>
      </div>
    </Device>
  );
}

/* 07 · Resume ready */
function Resume({ go, tab }) {
  return (
    <Device>
      <div className="aw-body aw-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div className="aw-resume__hero">
          <div className="aw-stamp"><i className="ph-bold ph-check"></i></div>
          <h2>Resume ready! 🎉</h2>
          <p>Ek branded resume — bilkul free.</p>
        </div>
        <div className="aw-doc">
          <div className="aw-doc__top"><div><div className="aw-doc__name">Ramesh Kumar</div><div className="aw-doc__role">CNC Operator · 6 years</div></div><img src={LOGO_SRC} style={{ width: 30, height: 30, borderRadius: 8 }} alt="" /></div>
          <div className="aw-doc__sec"><div className="aw-doc__sh">Skills</div><div className="aw-chips"><span className="aw-tag">Fanuc control</span><span className="aw-tag">VMC setting</span><span className="aw-tag">GD&amp;T</span><span className="aw-tag">Quality check</span></div></div>
          <div className="aw-doc__sec"><div className="aw-doc__sh">Experience</div><div className="aw-doc__exp"><b>Operator</b> · Kalyani Industries · 2020–now</div><div className="aw-doc__exp"><b>Trainee</b> · MIDC Bhosari · 2018–2020</div></div>
          <div className="aw-doc__wm">Made with BadaBhai</div>
        </div>
        <button className="aw-btn aw-btn--brand"><i className="ph-bold ph-download-simple"></i> Download PDF</button>
        <button className="aw-btn aw-btn--go"><i className="ph-fill ph-whatsapp-logo"></i> WhatsApp pe share</button>
        <button className="aw-btn aw-btn--ghost" onClick={() => go('resumeEdit')}>Naam / photo / phone edit karein</button>
      </div>
      <Nav tab={tab || 'resume'} go={go} />
    </Device>
  );
}

/* 08 · Resume safe-field edit */
function ResumeEdit({ go }) {
  const F = [['Naam ki spelling', 'Ramesh Kumar', 1], ['Photo dikhayein', '', 1], ['Phone employer ko dikhe', '', 1], ['Night shift ke liye taiyaar', '', 0]];
  return (
    <Device>
      <div className="aw-bar"><button className="aw-back" onClick={() => go('resume')}><i className="ph ph-arrow-left"></i></button><div className="aw-bar__t"><div className="aw-bar__title">Aap control karte hain</div></div></div>
      <div className="aw-body aw-pad">
        <p className="aw-muted" style={{ marginBottom: 8 }}>Sirf yeh fields aap badal sakte hain. Baaki resume bada bhai sambhalta hai.</p>
        {F.map(([l, v, on], i) => (
          <div className="aw-field" key={i}>
            <div className="aw-field__l"><b>{l}</b>{v && <small>{v}</small>}</div>
            {v ? <button className="aw-iconbtn" style={{ width: 40, height: 40 }}><i className="ph ph-pencil-simple"></i></button> : <div className={'aw-toggle' + (on ? ' on' : '')}><i></i></div>}
          </div>
        ))}
        <button className="aw-btn aw-btn--go" style={{ marginTop: 22 }}><i className="ph-bold ph-check"></i> Save karein</button>
      </div>
    </Device>
  );
}

/* 09 · Interview kit list */
function Kit({ go, tab }) {
  return (
    <Device>
      <div className="aw-bar"><div className="aw-bar__t"><div className="aw-bar__title">Interview kit</div></div></div>
      <div className="aw-body aw-pad">
        <p className="aw-muted" style={{ marginBottom: 14 }}>Aapke trade ke common sawaal aur jawaab. Interview se pehle padhein.</p>
        <div className="aw-card" style={{ padding: 0, marginBottom: 14 }}>
          <div className="aw-kitrow" onClick={() => go('kitDetail')} style={{ cursor: 'pointer' }}>
            <div className="aw-kitrow__ic"><i className="ph-fill ph-wrench"></i></div>
            <div style={{ flex: 1 }}><div className="aw-card__h">CNC Operator</div><div className="aw-muted">15 sawaal · jawaab ke saath</div></div>
            <i className="ph ph-caret-right" style={{ color: 'var(--text-faint)' }}></i>
          </div>
        </div>
        <div className="aw-card" style={{ padding: 0 }}>
          <div className="aw-kitrow"><div className="aw-kitrow__ic" style={{ background: 'var(--green-100)', color: 'var(--green-700)' }}><i className="ph-fill ph-clipboard-text"></i></div><div style={{ flex: 1 }}><div className="aw-card__h">Interview din ki checklist</div><div className="aw-muted">Documents · pehnaava · timing</div></div><i className="ph ph-caret-right" style={{ color: 'var(--text-faint)' }}></i></div>
        </div>
      </div>
      <Nav tab={tab || 'resume'} go={go} />
    </Device>
  );
}

/* 10 · Interview kit detail */
function KitDetail({ go }) {
  const Q = [
    ['Fanuc aur Siemens control mein kya farq hai?', 'Dono CNC controllers hain — Fanuc zyada common hai India mein. G-code thoda alag hota hai; main dono pe kaam kar chuka hoon.'],
    ['Tool offset kaise set karte hain?', 'Tool ko reference par le jaakar, offset page mein X aur Z values daalte hain; phir trial cut se verify karte hain.'],
    ['Job reject ho jaye to kya karein?', 'Pehle drawing aur GD&T check karte hain, phir tool wear aur program dekhte hain. Supervisor ko turant batate hain.'],
  ];
  return (
    <Device>
      <div className="aw-bar"><button className="aw-back" onClick={() => go('kit')}><i className="ph ph-arrow-left"></i></button><div className="aw-bar__t"><div className="aw-bar__title" style={{ fontSize: 19 }}>CNC Operator</div></div><button className="aw-iconbtn"><i className="ph ph-download-simple"></i></button></div>
      <div className="aw-body aw-pad">
        {Q.map(([q, a], i) => <div className="aw-q" key={i}><b>Q{i + 1}. {q}</b><p>{a}</p></div>)}
      </div>
    </Device>
  );
}

/* 11 · Job feed */
function Feed({ go, tab }) {
  return (
    <Device>
      <div className="aw-feed__hd">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div><div className="aw-feed__eb">Jobs near you</div><div className="aw-feed__loc"><i className="ph-fill ph-map-pin"></i> Pune · 15 km</div></div>
          <button className="aw-iconbtn" onClick={() => go('filters')}><i className="ph ph-sliders-horizontal"></i></button>
        </div>
      </div>
      <div className="aw-chips aw-chips--scroll" style={{ padding: '0 18px 14px' }}>
        <span className="aw-chip is-on"><i className="ph ph-wrench"></i> CNC</span>
        <span className="aw-chip"><i className="ph ph-wrench"></i> VMC</span>
        <span className="aw-chip"><i className="ph ph-shield-check"></i> Verified</span>
        <span className="aw-chip"><i className="ph ph-clock"></i> Day shift</span>
      </div>
      <div className="aw-body">
        <div className="aw-deck">
          <div className="aw-deck__behind aw-deck__b2"></div>
          <div className="aw-deck__behind aw-deck__b1"></div>
          <div className="aw-job">
            <div className="aw-job__top">
              <div><div className="aw-job__title" onClick={() => go('jobDetail')} style={{ cursor: 'pointer' }}>CNC Operator</div><div className="aw-job__co">Sharma Precision Works <i className="ph-fill ph-seal-check"></i></div></div>
              <div className="aw-job__logo"><i className="ph ph-buildings"></i></div>
            </div>
            <div className="aw-job__facts"><span><i className="ph ph-map-pin"></i> Pimpri</span><span><i className="ph ph-clock"></i> Day</span><span><i className="ph ph-currency-inr"></i> <b className="aw-job__sal">22–28k</b></span></div>
            <div className="aw-chips"><span className="aw-tag">Fanuc</span><span className="aw-tag">2+ yrs</span><span className="aw-tag">PF + ESI</span></div>
            <div className="aw-job__quota"><i className="ph ph-users-three"></i> <b>4 spots</b> left</div>
            <div className="aw-job__cta"><button className="aw-skip" onClick={() => go('feed')}><i className="ph ph-x"></i></button><button className="aw-btn aw-btn--go" style={{ flex: 1 }} onClick={() => go('applied')}><i className="ph-bold ph-check"></i> Apply</button></div>
          </div>
        </div>
        <div className="aw-swipehint"><i className="ph ph-hand-swipe-left"></i> Skip · Apply <i className="ph ph-hand-swipe-right"></i></div>
      </div>
      <Nav tab={tab || 'feed'} go={go} />
    </Device>
  );
}

/* 12 · Job detail */
function JobDetail({ go }) {
  return (
    <Device>
      <div className="aw-bar"><button className="aw-back" onClick={() => go('feed')}><i className="ph ph-arrow-left"></i></button><div className="aw-bar__t"></div><button className="aw-iconbtn"><i className="ph ph-share-network"></i></button></div>
      <div className="aw-body">
        <div className="aw-jd__head">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}><div><div className="aw-jd__title">CNC Operator</div><div className="aw-job__co" style={{ fontSize: 15 }}>Sharma Precision Works <i className="ph-fill ph-seal-check"></i></div></div><div className="aw-job__logo"><i className="ph ph-buildings"></i></div></div>
          <div className="aw-job__facts" style={{ marginTop: 14 }}><span><i className="ph ph-map-pin"></i> Pimpri, Pune</span><span><i className="ph ph-clock"></i> Day shift</span><span><i className="ph ph-currency-inr"></i> <b className="aw-job__sal">22,000–28,000/mo</b></span></div>
        </div>
        <div className="aw-jd__block"><div className="aw-jd__sh">Kaam kya hai</div><div className="aw-jd__li"><i className="ph-fill ph-check-circle"></i> Fanuc CNC machine operate karna</div><div className="aw-jd__li"><i className="ph-fill ph-check-circle"></i> Program load + quality check</div><div className="aw-jd__li"><i className="ph-fill ph-check-circle"></i> Output target maintain karna</div></div>
        <div className="aw-jd__block"><div className="aw-jd__sh">Chahiye</div><div className="aw-chips"><span className="aw-tag">Fanuc control</span><span className="aw-tag">2+ yrs</span><span className="aw-tag">ITI / diploma</span></div></div>
        <div className="aw-jd__block" style={{ border: 'none' }}><div className="aw-jd__sh">Faayde</div><div className="aw-jd__li"><i className="ph-fill ph-check-circle"></i> PF + ESI + overtime</div><div className="aw-jd__li"><i className="ph-fill ph-check-circle"></i> Canteen + transport</div></div>
      </div>
      <div className="aw-stickycta"><button className="aw-skip" onClick={() => go('feed')}><i className="ph ph-x"></i></button><button className="aw-btn aw-btn--go" style={{ flex: 1 }} onClick={() => go('applied')}><i className="ph-bold ph-check"></i> Apply karein</button></div>
    </Device>
  );
}

/* 13 · Filters (sheet over feed) */
function Filters({ go }) {
  return (
    <Device>
      <div className="aw-feed__hd"><div className="aw-feed__eb">Jobs near you</div><div className="aw-feed__loc"><i className="ph-fill ph-map-pin"></i> Pune · 15 km</div></div>
      <div className="aw-body" style={{ filter: 'blur(1px)', opacity: .5 }}><div className="aw-deck"><div className="aw-job" style={{ minHeight: 280 }}></div></div></div>
      <div className="aw-sheetwrap">
        <div className="aw-sheet">
          <div className="aw-sheet__grip"></div>
          <h3 className="aw-sheet__h">Filter jobs</h3>
          <div className="aw-fgroup"><div className="aw-fgroup__l">Trade</div><div className="aw-chips"><span className="aw-chip is-on">CNC</span><span className="aw-chip is-on">VMC</span><span className="aw-chip">Welder</span><span className="aw-chip">Fitter</span><span className="aw-chip">QC</span></div></div>
          <div className="aw-fgroup"><div className="aw-fgroup__l">Distance</div><div className="aw-chips"><span className="aw-chip">5 km</span><span className="aw-chip is-on">15 km</span><span className="aw-chip">30 km</span></div></div>
          <div className="aw-fgroup"><div className="aw-fgroup__l">Shift</div><div className="aw-chips"><span className="aw-chip is-on">Day</span><span className="aw-chip">Night</span><span className="aw-chip">Rotational</span></div></div>
          <button className="aw-btn aw-btn--go" onClick={() => go('feed')}>Show 24 jobs</button>
        </div>
      </div>
    </Device>
  );
}

/* 14 · Applied */
function Applied({ go }) {
  return (
    <Device>
      <div className="aw-body">
        <div className="aw-applied">
          <div className="aw-stamp"><i className="ph-bold ph-check"></i></div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 26, margin: 0 }}>Apply ho gaya!</h2>
          <p className="aw-muted">Sharma Precision Works ko aapka profile bhej diya. Reply aane par hum aapko batayenge.</p>
        </div>
        <div className="aw-pad" style={{ paddingTop: 0 }}>
          <div className="aw-card" style={{ padding: 0, marginBottom: 16 }}>
            <div className="aw-status-row"><div className="aw-status-row__ic is-green"><i className="ph-fill ph-paper-plane-right"></i></div><div><b style={{ color: 'var(--text-primary)' }}>Applied</b><div className="aw-muted">Abhi · CNC Operator</div></div></div>
            <div className="aw-status-row" style={{ borderTop: '1px solid var(--divider)' }}><div className="aw-status-row__ic is-saffron"><i className="ph-fill ph-eye"></i></div><div><b style={{ color: 'var(--text-primary)' }}>Employer ne dekha</b><div className="aw-muted">Pending</div></div></div>
          </div>
          <button className="aw-btn aw-btn--go" onClick={() => go('feed')}>Aur jobs dekhein <i className="ph-bold ph-arrow-right"></i></button>
        </div>
      </div>
      <Nav tab={'feed'} go={go} />
    </Device>
  );
}

/* 15 · Profile */
function Profile({ go, tab }) {
  return (
    <Device>
      <div className="aw-bar"><div className="aw-bar__t"><div className="aw-bar__title" style={{ fontSize: 26 }}>Profile</div></div><button className="aw-iconbtn" onClick={() => go('settings')}><i className="ph ph-gear"></i></button></div>
      <div className="aw-body aw-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="aw-prof__head">
          <div className="aw-prof__av">RK<span className="aw-prof__seal"><i className="ph-fill ph-seal-check"></i></span></div>
          <div><div className="aw-prof__name">Ramesh Kumar</div><div className="aw-muted">CNC Operator · Pune</div><span className="aw-badge-verified" style={{ marginTop: 6 }}><i className="ph-fill ph-seal-check"></i> Verified</span></div>
        </div>
        <div className="aw-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700, marginBottom: 8 }}><span>Profile strength</span><span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>72%</span></div>
          <div className="aw-prog"><i style={{ width: '72%' }}></i></div>
          <p className="aw-muted" style={{ marginTop: 10 }}>Ek photo add karein aur 100% tak pahunchein.</p>
        </div>
        <div className="aw-card aw-kit" style={{ display: 'flex', alignItems: 'center', gap: 13, cursor: 'pointer' }} onClick={() => go('kit')}>
          <div className="aw-kitrow__ic"><i className="ph-fill ph-exam"></i></div>
          <div style={{ flex: 1 }}><div className="aw-card__h">Interview kit</div><div className="aw-muted">15 sawaal + jawaab</div></div>
          <i className="ph ph-caret-right" style={{ color: 'var(--text-faint)' }}></i>
        </div>
      </div>
      <Nav tab={tab || 'profile'} go={go} />
    </Device>
  );
}

/* 16 · Settings */
function Settings({ go }) {
  const rows = [
    ['translate', 'Bhasha', 'हिंदी', 0],
    ['whatsapp-logo', 'WhatsApp alerts', 'Job alert · resume · reply', 0],
    ['bell', 'Notifications', 'On', 0],
    ['shield-check', 'Privacy & data', 'Consent · download · delete', 0],
    ['trash', 'Account delete karein', 'OTP ke baad 7 din mein', 1],
  ];
  return (
    <Device>
      <div className="aw-bar"><button className="aw-back" onClick={() => go('profile')}><i className="ph ph-arrow-left"></i></button><div className="aw-bar__t"><div className="aw-bar__title">Settings</div></div></div>
      <div className="aw-body aw-pad">
        {rows.map(([ic, t, s, danger]) => (
          <div className={'aw-srow' + (danger ? ' aw-srow--danger' : '')} key={t}>
            <div className="aw-srow__ic"><i className={'ph ph-' + ic}></i></div>
            <div><b>{t}</b><small>{s}</small></div>
            <i className="ph ph-caret-right aw-srow__chev"></i>
          </div>
        ))}
        <p className="aw-legal" style={{ marginTop: 20 }}>BadaBhai · v1.0 · Made in India 🇮🇳</p>
      </div>
    </Device>
  );
}

/* 17 · Notifications / alerts */
function Notifications({ go, tab }) {
  const N = [
    ['green', 'briefcase', 'Naya job — CNC Operator', 'Sharma Precision Works · Pimpri · ₹22–28k', 'Abhi'],
    ['saffron', 'eye', 'Employer ne aapka profile dekha', 'Deccan Auto Components', '2 ghante'],
    ['brand', 'file-text', 'Aapka resume taiyaar hai', 'Download ya WhatsApp pe share karein', 'Kal'],
  ];
  const bg = { green: 'is-green', saffron: 'is-saffron', brand: '' };
  return (
    <Device>
      <div className="aw-bar"><div className="aw-bar__t"><div className="aw-bar__title">Alerts</div></div><button className="aw-iconbtn"><i className="ph ph-check"></i></button></div>
      <div className="aw-body aw-pad">
        {N.map(([c, ic, t, p, time], i) => (
          <div className="aw-noti" key={i}>
            <div className={'aw-noti__ic ' + (bg[c] || '')} style={c === 'brand' ? { background: 'var(--vermilion-50)', color: 'var(--brand)' } : {}}><i className={'ph-fill ph-' + ic}></i></div>
            <div style={{ flex: 1 }}><b>{t}</b><p>{p}</p></div>
            <small className="aw-muted">{time}</small>
          </div>
        ))}
      </div>
      <Nav tab={tab || 'notifications'} go={go} />
    </Device>
  );
}

window.AW = {
  Device, Logo, Nav,
  screens: { splash: Splash, phone: Phone, otp: Otp, consent: Consent, chat: Chat, building: Building, resume: Resume, resumeEdit: ResumeEdit, kit: Kit, kitDetail: KitDetail, feed: Feed, jobDetail: JobDetail, filters: Filters, applied: Applied, profile: Profile, settings: Settings, notifications: Notifications },
  order: [
    ['splash', '01 Splash + language', 'First open — language first, no test'],
    ['phone', '02 Phone', 'Phone number entry'],
    ['otp', '03 OTP', '4-digit verification'],
    ['consent', '04 Consent', 'DPDP + model-training consent gate'],
    ['chat', '05 Chat onboarding', 'Bada bhai profiles you + form pop-up'],
    ['building', '06 Building', 'Generating the resume'],
    ['resume', '07 Resume ready', 'Free branded resume + share'],
    ['resumeEdit', '08 Resume edit', 'Safe fields the worker controls'],
    ['kit', '09 Interview kit', 'Per-trade Q&A list'],
    ['kitDetail', '10 Interview kit detail', 'Questions + answers'],
    ['feed', '11 Job feed', 'Swipe-to-apply'],
    ['jobDetail', '12 Job detail', 'Full posting'],
    ['filters', '13 Filters', 'Trade / distance / shift sheet'],
    ['applied', '14 Applied', 'Application confirmed + status'],
    ['profile', '15 Profile', 'Strength + verified + kit'],
    ['settings', '16 Settings', 'Language · WhatsApp · privacy · delete'],
    ['notifications', '17 Alerts', 'Jobs · views · resume nudges'],
  ],
};
})();
