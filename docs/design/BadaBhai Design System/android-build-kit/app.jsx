(function () {
  const { screens, order } = window.AW;
  const W = 384, H = 832;

  const tabFor = { feed: 'feed', resume: 'resume', profile: 'profile', notifications: 'notifications', kit: 'resume', applied: 'feed' };

  function FlowApp() {
    const [screen, setScreen] = React.useState('splash');
    const go = (id) => { if (screens[id]) setScreen(id); };
    const S = screens[screen];
    return <div className="aw-stage"><S go={go} live={true} tab={tabFor[screen]} /></div>;
  }

  function Gallery() {
    const scale = 0.6;
    return (
      <div className="aw-gallery">
        <div className="aw-gallery__head">
          <h1>BadaBhai Worker App — all screens</h1>
          <p>The complete worker flow in the Desi Vernacular Pop theme — onboarding, chat-built
          profile, free resume, interview kit, swipe-to-apply jobs, and account. 17 screens, end to end.
          Switch to “Interactive flow” to click through it.</p>
        </div>
        <div className="aw-grid">
          {order.map(([id, cap, desc], i) => {
            const S = screens[id];
            return (
              <div className="aw-tile" key={id}>
                <div className="aw-tile__cap"><span>{String(i + 1).padStart(2, '0')}</span>{cap.replace(/^\d+\s/, '')}</div>
                <div className="aw-tile__d">{desc}</div>
                <div style={{ width: W * scale, height: H * scale, overflow: 'hidden' }}>
                  <div className="aw-tile__frame" style={{ transform: `scale(${scale})`, width: W }}>
                    <S go={() => {}} live={false} tab={tabFor[id]} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function App() {
    const [mode, setMode] = React.useState('flow');
    return (
      <React.Fragment>
        <div className="aw-modebar">
          <button className={mode === 'flow' ? 'is-on' : ''} onClick={() => setMode('flow')}>Interactive flow</button>
          <button className={mode === 'all' ? 'is-on' : ''} onClick={() => setMode('all')}>All screens</button>
        </div>
        {mode === 'flow' ? <FlowApp /> : <Gallery />}
      </React.Fragment>
    );
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<App />);
})();
