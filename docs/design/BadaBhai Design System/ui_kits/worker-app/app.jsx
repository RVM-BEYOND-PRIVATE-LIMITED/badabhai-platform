(function () {
const { BottomNav } = window.BadaBhaiDesignSystem_01ff85;

/* Worker app flow: login → chat onboarding → resume → tabbed app (jobs/resume/profile). */
function WorkerApp() {
  const [phase, setPhase] = React.useState('login');
  const [tab, setTab] = React.useState('jobs');

  if (phase === 'login') {
    return <window.LoginScreen onDone={() => setPhase('chat')} />;
  }
  if (phase === 'chat') {
    return <window.DeviceFrame><window.ChatScreen onResume={() => setPhase('resume')} /></window.DeviceFrame>;
  }
  if (phase === 'resume') {
    return (
      <window.DeviceFrame>
        <window.ResumeScreen onExplore={() => { setTab('jobs'); setPhase('app'); }} />
      </window.DeviceFrame>
    );
  }

  const body = {
    jobs: <window.FeedScreen />,
    resume: <window.ResumeScreen />,
    profile: <window.ProfileScreen />,
  }[tab];

  return (
    <window.DeviceFrame>
      <div className="wa-app">
        <div className="wa-app__body">{body}</div>
        <BottomNav value={tab} onChange={setTab} items={[
          { id: 'jobs', label: 'Jobs', icon: 'briefcase' },
          { id: 'resume', label: 'Resume', icon: 'file-text' },
          { id: 'profile', label: 'Profile', icon: 'user' },
        ]} />
      </div>
    </window.DeviceFrame>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<WorkerApp />);
})();
