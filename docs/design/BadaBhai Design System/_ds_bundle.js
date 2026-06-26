/* @ds-bundle: {"format":3,"namespace":"BadaBhaiDesignSystem_01ff85","components":[{"name":"BadaBhaiLogo","sourcePath":"components/brand/BadaBhaiLogo.jsx"},{"name":"ChatBubble","sourcePath":"components/brand/ChatBubble.jsx"},{"name":"JobCard","sourcePath":"components/brand/JobCard.jsx"},{"name":"MaskedCandidate","sourcePath":"components/brand/MaskedCandidate.jsx"},{"name":"Avatar","sourcePath":"components/display/Avatar.jsx"},{"name":"Badge","sourcePath":"components/display/Badge.jsx"},{"name":"Card","sourcePath":"components/display/Card.jsx"},{"name":"Chip","sourcePath":"components/display/Chip.jsx"},{"name":"StatTile","sourcePath":"components/display/StatTile.jsx"},{"name":"Dialog","sourcePath":"components/feedback/Dialog.jsx"},{"name":"ProgressBar","sourcePath":"components/feedback/ProgressBar.jsx"},{"name":"Toast","sourcePath":"components/feedback/Toast.jsx"},{"name":"Tooltip","sourcePath":"components/feedback/Tooltip.jsx"},{"name":"Button","sourcePath":"components/forms/Button.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"IconButton","sourcePath":"components/forms/IconButton.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"OtpInput","sourcePath":"components/forms/OtpInput.jsx"},{"name":"Radio","sourcePath":"components/forms/Radio.jsx"},{"name":"Select","sourcePath":"components/forms/Select.jsx"},{"name":"Switch","sourcePath":"components/forms/Switch.jsx"},{"name":"Textarea","sourcePath":"components/forms/Textarea.jsx"},{"name":"BottomNav","sourcePath":"components/navigation/BottomNav.jsx"},{"name":"Tabs","sourcePath":"components/navigation/Tabs.jsx"}],"sourceHashes":{"android-build-kit/app.jsx":"0a28bcac8589","android-build-kit/screens.jsx":"117d050e8e6b","components/brand/BadaBhaiLogo.jsx":"0f35d5487c09","components/brand/ChatBubble.jsx":"8bb84e8e1f82","components/brand/JobCard.jsx":"34c0258b7ce5","components/brand/MaskedCandidate.jsx":"2d6273ba6e84","components/display/Avatar.jsx":"d901830dc205","components/display/Badge.jsx":"9d60def57f45","components/display/Card.jsx":"30e989ef2afa","components/display/Chip.jsx":"c3a628329b88","components/display/StatTile.jsx":"f349ef33fea6","components/feedback/Dialog.jsx":"c32c264a1e97","components/feedback/ProgressBar.jsx":"a6e8ff7dea72","components/feedback/Toast.jsx":"5eef073d4e99","components/feedback/Tooltip.jsx":"844ee24cf3b9","components/forms/Button.jsx":"b7e89a1359a1","components/forms/Checkbox.jsx":"721f823a7199","components/forms/IconButton.jsx":"5e59e35e801a","components/forms/Input.jsx":"ec570b87276f","components/forms/OtpInput.jsx":"e6ac33e75ec5","components/forms/Radio.jsx":"907745a655aa","components/forms/Select.jsx":"26051d153c73","components/forms/Switch.jsx":"002c658c7e1b","components/forms/Textarea.jsx":"a604267501f8","components/navigation/BottomNav.jsx":"4c2b6110df8b","components/navigation/Tabs.jsx":"a38b2a71d166","ui_kits/company-web/app.jsx":"28562aa6d58a","ui_kits/company-web/screens.jsx":"690d06a40945","ui_kits/worker-app/app.jsx":"8d28470a0fba","ui_kits/worker-app/screens.jsx":"090d954fd262"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.BadaBhaiDesignSystem_01ff85 = window.BadaBhaiDesignSystem_01ff85 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// android-build-kit/app.jsx
try { (() => {
(function () {
  const {
    screens,
    order
  } = window.AW;
  const W = 384,
    H = 832;
  const tabFor = {
    feed: 'feed',
    resume: 'resume',
    profile: 'profile',
    notifications: 'notifications',
    kit: 'resume',
    applied: 'feed'
  };
  function FlowApp() {
    const [screen, setScreen] = React.useState('splash');
    const go = id => {
      if (screens[id]) setScreen(id);
    };
    const S = screens[screen];
    return /*#__PURE__*/React.createElement("div", {
      className: "aw-stage"
    }, /*#__PURE__*/React.createElement(S, {
      go: go,
      live: true,
      tab: tabFor[screen]
    }));
  }
  function Gallery() {
    const scale = 0.6;
    return /*#__PURE__*/React.createElement("div", {
      className: "aw-gallery"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-gallery__head"
    }, /*#__PURE__*/React.createElement("h1", null, "BadaBhai Worker App \u2014 all screens"), /*#__PURE__*/React.createElement("p", null, "The complete worker flow in the Desi Vernacular Pop theme \u2014 onboarding, chat-built profile, free resume, interview kit, swipe-to-apply jobs, and account. 17 screens, end to end. Switch to \u201CInteractive flow\u201D to click through it.")), /*#__PURE__*/React.createElement("div", {
      className: "aw-grid"
    }, order.map(([id, cap, desc], i) => {
      const S = screens[id];
      return /*#__PURE__*/React.createElement("div", {
        className: "aw-tile",
        key: id
      }, /*#__PURE__*/React.createElement("div", {
        className: "aw-tile__cap"
      }, /*#__PURE__*/React.createElement("span", null, String(i + 1).padStart(2, '0')), cap.replace(/^\d+\s/, '')), /*#__PURE__*/React.createElement("div", {
        className: "aw-tile__d"
      }, desc), /*#__PURE__*/React.createElement("div", {
        style: {
          width: W * scale,
          height: H * scale,
          overflow: 'hidden'
        }
      }, /*#__PURE__*/React.createElement("div", {
        className: "aw-tile__frame",
        style: {
          transform: `scale(${scale})`,
          width: W
        }
      }, /*#__PURE__*/React.createElement(S, {
        go: () => {},
        live: false,
        tab: tabFor[id]
      }))));
    })));
  }
  function App() {
    const [mode, setMode] = React.useState('flow');
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-modebar"
    }, /*#__PURE__*/React.createElement("button", {
      className: mode === 'flow' ? 'is-on' : '',
      onClick: () => setMode('flow')
    }, "Interactive flow"), /*#__PURE__*/React.createElement("button", {
      className: mode === 'all' ? 'is-on' : '',
      onClick: () => setMode('all')
    }, "All screens")), mode === 'flow' ? /*#__PURE__*/React.createElement(FlowApp, null) : /*#__PURE__*/React.createElement(Gallery, null));
  }
  ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(App, null));
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "android-build-kit/app.jsx", error: String((e && e.message) || e) }); }

// android-build-kit/screens.jsx
try { (() => {
/* BadaBhai · Worker App (Android build kit) — all screens.
   Self-contained (no design-system bundle); reads brand tokens from styles.css. */
(function () {
  // Inline logo so the kit works as a single file (file://, bundled, or over HTTP).
  var LOGO_SRC = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'%3E%3Crect width='512' height='512' rx='128' fill='%23E0371C'/%3E%3Cpath d='M150 124h212a40 40 0 0 1 40 40v132a40 40 0 0 1-40 40H252l-78 62a12 12 0 0 1-19.4-9.4V336h-4.6a40 40 0 0 1-40-40V164a40 40 0 0 1 40-40Z' fill='%23ffffff'/%3E%3Cpath d='M196 268l60-58 60 58' stroke='%230E7A4F' stroke-width='32' stroke-linecap='round' stroke-linejoin='round' fill='none'/%3E%3C/svg%3E";
  function Logo({
    size = 40,
    text = 22,
    wordmark = true
  }) {
    return /*#__PURE__*/React.createElement("span", {
      className: "aw-logo",
      style: {
        '--lz': size + 'px',
        '--lt': text + 'px'
      }
    }, /*#__PURE__*/React.createElement("img", {
      src: LOGO_SRC,
      alt: ""
    }), wordmark && /*#__PURE__*/React.createElement("b", null, "Bada", /*#__PURE__*/React.createElement("span", {
      className: "v"
    }, "Bhai")));
  }
  function Device({
    children,
    dark
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: "aw-phone"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-screen"
    }, /*#__PURE__*/React.createElement("div", {
      className: 'aw-status' + (dark ? ' is-dark' : '')
    }, /*#__PURE__*/React.createElement("span", null, "9:41"), /*#__PURE__*/React.createElement("span", {
      className: "i"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-cell-signal-full"
    }), /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-wifi-high"
    }), /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-battery-high"
    }))), children));
  }
  function Nav({
    tab,
    go
  }) {
    const items = [['feed', 'Jobs', 'briefcase'], ['resume', 'Resume', 'file-text'], ['profile', 'Profile', 'user'], ['notifications', 'Alerts', 'bell']];
    return /*#__PURE__*/React.createElement("div", {
      className: "aw-nav"
    }, items.map(([id, l, ic]) => /*#__PURE__*/React.createElement("button", {
      key: id,
      className: tab === id ? 'is-on' : '',
      onClick: () => go(id)
    }, /*#__PURE__*/React.createElement("i", {
      className: (tab === id ? 'ph-fill' : 'ph') + ' ph-' + ic
    }), id === 'notifications' && /*#__PURE__*/React.createElement("span", {
      className: "aw-nav__badge"
    }, "2"), l)));
  }

  /* 01 · Splash + language */
  function Splash({
    go
  }) {
    const [lang, setLang] = React.useState('hi');
    const L = [['hi', 'हिंदी', 'Hindi'], ['mr', 'मराठी', 'Marathi'], ['bho', 'भोजपुरी', 'Bhojpuri'], ['en', 'English', 'English']];
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-splash"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-splash__hero"
    }, /*#__PURE__*/React.createElement(Logo, {
      size: 72,
      wordmark: false
    }), /*#__PURE__*/React.createElement("h1", null, "Aapka kaam,", /*#__PURE__*/React.createElement("br", null), "bada bhai ke saath."), /*#__PURE__*/React.createElement("p", null, "No test. Just talk.")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "aw-label"
    }, "Aap kis bhasha mein baat karein?"), /*#__PURE__*/React.createElement("div", {
      className: "aw-langgrid"
    }, L.map(([id, big, sub]) => /*#__PURE__*/React.createElement("button", {
      key: id,
      className: 'aw-lang' + (lang === id ? ' is-on' : ''),
      onClick: () => setLang(id)
    }, /*#__PURE__*/React.createElement("span", null, big, /*#__PURE__*/React.createElement("small", null, sub)), lang === id && /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-check-circle"
    })))), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--brand",
      onClick: () => go('phone')
    }, "Chalo shuru karein ", /*#__PURE__*/React.createElement("i", {
      className: "ph-bold ph-arrow-right"
    })))));
  }

  /* 02 · Phone */
  function Phone({
    go
  }) {
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar"
    }, /*#__PURE__*/React.createElement("button", {
      className: "aw-back",
      onClick: () => go('splash')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-arrow-left"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-body aw-pad"
    }, /*#__PURE__*/React.createElement("h1", {
      style: {
        fontFamily: 'var(--font-display)',
        fontSize: 28,
        fontWeight: 800,
        margin: '6px 0 8px',
        color: 'var(--text-primary)'
      }
    }, "Apna number daalein"), /*#__PURE__*/React.createElement("p", {
      className: "aw-muted",
      style: {
        marginBottom: 22
      }
    }, "Hum ek OTP bhejenge. Aapka number kisi employer ko nahi dikhta jab tak aap na chaahein."), /*#__PURE__*/React.createElement("label", {
      className: "aw-label"
    }, "Phone number"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: 10,
        marginBottom: 22
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-input",
      style: {
        width: 78,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700
      }
    }, "+91"), /*#__PURE__*/React.createElement("input", {
      className: "aw-input",
      defaultValue: "98765 43210",
      inputMode: "tel"
    })), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--brand",
      onClick: () => go('otp')
    }, "OTP bhejein ", /*#__PURE__*/React.createElement("i", {
      className: "ph-bold ph-arrow-right"
    }))));
  }

  /* 03 · OTP */
  function Otp({
    go
  }) {
    const d = ['9', '4', '', ''];
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar"
    }, /*#__PURE__*/React.createElement("button", {
      className: "aw-back",
      onClick: () => go('phone')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-arrow-left"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-body aw-pad"
    }, /*#__PURE__*/React.createElement("h1", {
      style: {
        fontFamily: 'var(--font-display)',
        fontSize: 28,
        fontWeight: 800,
        margin: '6px 0 8px',
        color: 'var(--text-primary)'
      }
    }, "Code daalein"), /*#__PURE__*/React.createElement("p", {
      className: "aw-muted",
      style: {
        marginBottom: 26
      }
    }, "+91 98765 43210 par bheja gaya 4-digit code."), /*#__PURE__*/React.createElement("div", {
      className: "aw-otp",
      style: {
        marginBottom: 24
      }
    }, d.map((c, i) => /*#__PURE__*/React.createElement("span", {
      key: i,
      className: c ? 'on' : ''
    }, c))), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--brand",
      onClick: () => go('consent')
    }, "Verify & aage badhein"), /*#__PURE__*/React.createElement("p", {
      style: {
        textAlign: 'center',
        marginTop: 16
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "aw-linkbtn"
    }, "Code dobara bhejein \xB7 0:24"))));
  }

  /* 04 · Consent (DPDP) */
  function Consent({
    go
  }) {
    const rows = [['chat-circle-dots', 'Chat se profile', 'Bada bhai aapse baat karke profile banata hai — koi form nahi.'], ['shield-check', 'Aapka data, aapke India mein', 'Sab kuch Mumbai ke servers par. Aap kabhi bhi delete kar sakte hain.'], ['brain', 'Behtar madad ke liye', 'Aapki baat-cheet se hamara AI seekhta hai (model training).']];
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar"
    }, /*#__PURE__*/React.createElement("button", {
      className: "aw-back",
      onClick: () => go('otp')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-arrow-left"
    })), /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__t"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__title"
    }, "Sahmati"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-body aw-pad"
    }, rows.map(([ic, t, p]) => /*#__PURE__*/React.createElement("div", {
      className: "aw-consent__row",
      key: t
    }, /*#__PURE__*/React.createElement("i", {
      className: 'ph-fill ph-' + ic
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", null, t), /*#__PURE__*/React.createElement("p", null, p)))), /*#__PURE__*/React.createElement("p", {
      className: "aw-legal",
      style: {
        margin: '18px 0'
      }
    }, "Aage badhne par aap hamari Terms & data-use consent (incl. model training) se sahmat hain. DPDP ke tahat surakshit."), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--go",
      onClick: () => go('chat')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-bold ph-check"
    }), " Main sahmat hoon")));
  }

  /* 05 · Chat onboarding */
  function Chat({
    go
  }) {
    const msgs = [['bot', 'Namaste! 🙏 Main aapka bada bhai. 2 minute baat karein, phir profile aur resume taiyaar.'], ['bot', 'Aap kaun si machine pe kaam karte hain?'], ['me', 'CNC operator. Fanuc control.'], ['bot', 'Badhiya! Kitne saal ka experience hai?'], ['voice', '0:14']];
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar"
    }, /*#__PURE__*/React.createElement(Logo, {
      size: 34,
      wordmark: false
    }), /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__t"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__title",
      style: {
        fontSize: 18
      }
    }, "Bada Bhai"), /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__sub"
    }, /*#__PURE__*/React.createElement("span", {
      className: "aw-dot"
    }), " online")), /*#__PURE__*/React.createElement("button", {
      className: "aw-iconbtn"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-dots-three-vertical"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-body"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-chat"
    }, msgs.map((m, i) => m[0] === 'voice' ? /*#__PURE__*/React.createElement("div", {
      className: "aw-msg aw-msg--me",
      key: i
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bub"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-voice"
    }, /*#__PURE__*/React.createElement("span", {
      className: "aw-voice__play"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-play"
    })), /*#__PURE__*/React.createElement("span", {
      className: "aw-wave"
    }, [10, 16, 8, 20, 12, 18, 7, 14, 9].map((h, j) => /*#__PURE__*/React.createElement("i", {
      key: j,
      style: {
        height: h
      }
    }))), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: 'var(--font-mono)',
        fontSize: 12
      }
    }, m[1])))) : /*#__PURE__*/React.createElement("div", {
      className: 'aw-msg aw-msg--' + m[0],
      key: i
    }, m[0] === 'bot' && /*#__PURE__*/React.createElement("img", {
      className: "aw-msg__av",
      src: LOGO_SRC,
      alt: ""
    }), /*#__PURE__*/React.createElement("div", {
      className: "aw-bub"
    }, m[1]))), /*#__PURE__*/React.createElement("div", {
      className: "aw-pop"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-pop__h"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-magic-wand"
    }), " Yeh sahi hai? (tap to edit)"), /*#__PURE__*/React.createElement("div", {
      className: "aw-pop__field"
    }, /*#__PURE__*/React.createElement("b", null, "Trade"), /*#__PURE__*/React.createElement("span", null, "CNC Operator")), /*#__PURE__*/React.createElement("div", {
      className: "aw-pop__field"
    }, /*#__PURE__*/React.createElement("b", null, "Experience"), /*#__PURE__*/React.createElement("span", null, "6 saal")), /*#__PURE__*/React.createElement("div", {
      className: "aw-pop__field"
    }, /*#__PURE__*/React.createElement("b", null, "Location"), /*#__PURE__*/React.createElement("span", null, "Pimpri-Chinchwad")), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--go aw-btn--sm",
      style: {
        width: '100%',
        marginTop: 12
      },
      onClick: () => go('building')
    }, "Haan, resume banao")))), /*#__PURE__*/React.createElement("div", {
      className: "aw-composer"
    }, /*#__PURE__*/React.createElement("button", {
      className: "aw-mic"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-microphone"
    })), /*#__PURE__*/React.createElement("div", {
      className: "aw-composer__in"
    }, "Type ya mic dabaa ke boliye\u2026"), /*#__PURE__*/React.createElement("button", {
      className: "aw-mic",
      style: {
        background: 'var(--surface-sunken)',
        color: 'var(--text-muted)'
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-paper-plane-right"
    }))));
  }

  /* 06 · Building */
  function Building({
    go,
    live
  }) {
    React.useEffect(() => {
      if (!live) return;
      const t = setTimeout(() => go('resume'), 1800);
      return () => clearTimeout(t);
    }, [live]);
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-build"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-spin"
    }), /*#__PURE__*/React.createElement("h2", null, "Resume ban raha hai\u2026"), /*#__PURE__*/React.createElement("p", {
      className: "aw-muted"
    }, "Aapki baat se ek branded, share-ready resume taiyaar kar rahe hain.")));
  }

  /* 07 · Resume ready */
  function Resume({
    go,
    tab
  }) {
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-body aw-pad",
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 18
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-resume__hero"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-stamp"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-bold ph-check"
    })), /*#__PURE__*/React.createElement("h2", null, "Resume ready! \uD83C\uDF89"), /*#__PURE__*/React.createElement("p", null, "Ek branded resume \u2014 bilkul free.")), /*#__PURE__*/React.createElement("div", {
      className: "aw-doc"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-doc__top"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "aw-doc__name"
    }, "Ramesh Kumar"), /*#__PURE__*/React.createElement("div", {
      className: "aw-doc__role"
    }, "CNC Operator \xB7 6 years")), /*#__PURE__*/React.createElement("img", {
      src: LOGO_SRC,
      style: {
        width: 30,
        height: 30,
        borderRadius: 8
      },
      alt: ""
    })), /*#__PURE__*/React.createElement("div", {
      className: "aw-doc__sec"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-doc__sh"
    }, "Skills"), /*#__PURE__*/React.createElement("div", {
      className: "aw-chips"
    }, /*#__PURE__*/React.createElement("span", {
      className: "aw-tag"
    }, "Fanuc control"), /*#__PURE__*/React.createElement("span", {
      className: "aw-tag"
    }, "VMC setting"), /*#__PURE__*/React.createElement("span", {
      className: "aw-tag"
    }, "GD&T"), /*#__PURE__*/React.createElement("span", {
      className: "aw-tag"
    }, "Quality check"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-doc__sec"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-doc__sh"
    }, "Experience"), /*#__PURE__*/React.createElement("div", {
      className: "aw-doc__exp"
    }, /*#__PURE__*/React.createElement("b", null, "Operator"), " \xB7 Kalyani Industries \xB7 2020\u2013now"), /*#__PURE__*/React.createElement("div", {
      className: "aw-doc__exp"
    }, /*#__PURE__*/React.createElement("b", null, "Trainee"), " \xB7 MIDC Bhosari \xB7 2018\u20132020")), /*#__PURE__*/React.createElement("div", {
      className: "aw-doc__wm"
    }, "Made with BadaBhai")), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--brand"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-bold ph-download-simple"
    }), " Download PDF"), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--go"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-whatsapp-logo"
    }), " WhatsApp pe share"), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--ghost",
      onClick: () => go('resumeEdit')
    }, "Naam / photo / phone edit karein")), /*#__PURE__*/React.createElement(Nav, {
      tab: tab || 'resume',
      go: go
    }));
  }

  /* 08 · Resume safe-field edit */
  function ResumeEdit({
    go
  }) {
    const F = [['Naam ki spelling', 'Ramesh Kumar', 1], ['Photo dikhayein', '', 1], ['Phone employer ko dikhe', '', 1], ['Night shift ke liye taiyaar', '', 0]];
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar"
    }, /*#__PURE__*/React.createElement("button", {
      className: "aw-back",
      onClick: () => go('resume')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-arrow-left"
    })), /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__t"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__title"
    }, "Aap control karte hain"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-body aw-pad"
    }, /*#__PURE__*/React.createElement("p", {
      className: "aw-muted",
      style: {
        marginBottom: 8
      }
    }, "Sirf yeh fields aap badal sakte hain. Baaki resume bada bhai sambhalta hai."), F.map(([l, v, on], i) => /*#__PURE__*/React.createElement("div", {
      className: "aw-field",
      key: i
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-field__l"
    }, /*#__PURE__*/React.createElement("b", null, l), v && /*#__PURE__*/React.createElement("small", null, v)), v ? /*#__PURE__*/React.createElement("button", {
      className: "aw-iconbtn",
      style: {
        width: 40,
        height: 40
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-pencil-simple"
    })) : /*#__PURE__*/React.createElement("div", {
      className: 'aw-toggle' + (on ? ' on' : '')
    }, /*#__PURE__*/React.createElement("i", null)))), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--go",
      style: {
        marginTop: 22
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-bold ph-check"
    }), " Save karein")));
  }

  /* 09 · Interview kit list */
  function Kit({
    go,
    tab
  }) {
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__t"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__title"
    }, "Interview kit"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-body aw-pad"
    }, /*#__PURE__*/React.createElement("p", {
      className: "aw-muted",
      style: {
        marginBottom: 14
      }
    }, "Aapke trade ke common sawaal aur jawaab. Interview se pehle padhein."), /*#__PURE__*/React.createElement("div", {
      className: "aw-card",
      style: {
        padding: 0,
        marginBottom: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-kitrow",
      onClick: () => go('kitDetail'),
      style: {
        cursor: 'pointer'
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-kitrow__ic"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-wrench"
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-card__h"
    }, "CNC Operator"), /*#__PURE__*/React.createElement("div", {
      className: "aw-muted"
    }, "15 sawaal \xB7 jawaab ke saath")), /*#__PURE__*/React.createElement("i", {
      className: "ph ph-caret-right",
      style: {
        color: 'var(--text-faint)'
      }
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-card",
      style: {
        padding: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-kitrow"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-kitrow__ic",
      style: {
        background: 'var(--green-100)',
        color: 'var(--green-700)'
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-clipboard-text"
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-card__h"
    }, "Interview din ki checklist"), /*#__PURE__*/React.createElement("div", {
      className: "aw-muted"
    }, "Documents \xB7 pehnaava \xB7 timing")), /*#__PURE__*/React.createElement("i", {
      className: "ph ph-caret-right",
      style: {
        color: 'var(--text-faint)'
      }
    })))), /*#__PURE__*/React.createElement(Nav, {
      tab: tab || 'resume',
      go: go
    }));
  }

  /* 10 · Interview kit detail */
  function KitDetail({
    go
  }) {
    const Q = [['Fanuc aur Siemens control mein kya farq hai?', 'Dono CNC controllers hain — Fanuc zyada common hai India mein. G-code thoda alag hota hai; main dono pe kaam kar chuka hoon.'], ['Tool offset kaise set karte hain?', 'Tool ko reference par le jaakar, offset page mein X aur Z values daalte hain; phir trial cut se verify karte hain.'], ['Job reject ho jaye to kya karein?', 'Pehle drawing aur GD&T check karte hain, phir tool wear aur program dekhte hain. Supervisor ko turant batate hain.']];
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar"
    }, /*#__PURE__*/React.createElement("button", {
      className: "aw-back",
      onClick: () => go('kit')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-arrow-left"
    })), /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__t"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__title",
      style: {
        fontSize: 19
      }
    }, "CNC Operator")), /*#__PURE__*/React.createElement("button", {
      className: "aw-iconbtn"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-download-simple"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-body aw-pad"
    }, Q.map(([q, a], i) => /*#__PURE__*/React.createElement("div", {
      className: "aw-q",
      key: i
    }, /*#__PURE__*/React.createElement("b", null, "Q", i + 1, ". ", q), /*#__PURE__*/React.createElement("p", null, a)))));
  }

  /* 11 · Job feed */
  function Feed({
    go,
    tab
  }) {
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-feed__hd"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start'
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "aw-feed__eb"
    }, "Jobs near you"), /*#__PURE__*/React.createElement("div", {
      className: "aw-feed__loc"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-map-pin"
    }), " Pune \xB7 15 km")), /*#__PURE__*/React.createElement("button", {
      className: "aw-iconbtn",
      onClick: () => go('filters')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-sliders-horizontal"
    })))), /*#__PURE__*/React.createElement("div", {
      className: "aw-chips aw-chips--scroll",
      style: {
        padding: '0 18px 14px'
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "aw-chip is-on"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-wrench"
    }), " CNC"), /*#__PURE__*/React.createElement("span", {
      className: "aw-chip"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-wrench"
    }), " VMC"), /*#__PURE__*/React.createElement("span", {
      className: "aw-chip"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-shield-check"
    }), " Verified"), /*#__PURE__*/React.createElement("span", {
      className: "aw-chip"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-clock"
    }), " Day shift")), /*#__PURE__*/React.createElement("div", {
      className: "aw-body"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-deck"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-deck__behind aw-deck__b2"
    }), /*#__PURE__*/React.createElement("div", {
      className: "aw-deck__behind aw-deck__b1"
    }), /*#__PURE__*/React.createElement("div", {
      className: "aw-job"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-job__top"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "aw-job__title",
      onClick: () => go('jobDetail'),
      style: {
        cursor: 'pointer'
      }
    }, "CNC Operator"), /*#__PURE__*/React.createElement("div", {
      className: "aw-job__co"
    }, "Sharma Precision Works ", /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-seal-check"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-job__logo"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-buildings"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-job__facts"
    }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-map-pin"
    }), " Pimpri"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-clock"
    }), " Day"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-currency-inr"
    }), " ", /*#__PURE__*/React.createElement("b", {
      className: "aw-job__sal"
    }, "22\u201328k"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-chips"
    }, /*#__PURE__*/React.createElement("span", {
      className: "aw-tag"
    }, "Fanuc"), /*#__PURE__*/React.createElement("span", {
      className: "aw-tag"
    }, "2+ yrs"), /*#__PURE__*/React.createElement("span", {
      className: "aw-tag"
    }, "PF + ESI")), /*#__PURE__*/React.createElement("div", {
      className: "aw-job__quota"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-users-three"
    }), " ", /*#__PURE__*/React.createElement("b", null, "4 spots"), " left"), /*#__PURE__*/React.createElement("div", {
      className: "aw-job__cta"
    }, /*#__PURE__*/React.createElement("button", {
      className: "aw-skip",
      onClick: () => go('feed')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-x"
    })), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--go",
      style: {
        flex: 1
      },
      onClick: () => go('applied')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-bold ph-check"
    }), " Apply")))), /*#__PURE__*/React.createElement("div", {
      className: "aw-swipehint"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-hand-swipe-left"
    }), " Skip \xB7 Apply ", /*#__PURE__*/React.createElement("i", {
      className: "ph ph-hand-swipe-right"
    }))), /*#__PURE__*/React.createElement(Nav, {
      tab: tab || 'feed',
      go: go
    }));
  }

  /* 12 · Job detail */
  function JobDetail({
    go
  }) {
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar"
    }, /*#__PURE__*/React.createElement("button", {
      className: "aw-back",
      onClick: () => go('feed')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-arrow-left"
    })), /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__t"
    }), /*#__PURE__*/React.createElement("button", {
      className: "aw-iconbtn"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-share-network"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-body"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__head"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start'
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__title"
    }, "CNC Operator"), /*#__PURE__*/React.createElement("div", {
      className: "aw-job__co",
      style: {
        fontSize: 15
      }
    }, "Sharma Precision Works ", /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-seal-check"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-job__logo"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-buildings"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-job__facts",
      style: {
        marginTop: 14
      }
    }, /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-map-pin"
    }), " Pimpri, Pune"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-clock"
    }), " Day shift"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-currency-inr"
    }), " ", /*#__PURE__*/React.createElement("b", {
      className: "aw-job__sal"
    }, "22,000\u201328,000/mo")))), /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__block"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__sh"
    }, "Kaam kya hai"), /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__li"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-check-circle"
    }), " Fanuc CNC machine operate karna"), /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__li"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-check-circle"
    }), " Program load + quality check"), /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__li"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-check-circle"
    }), " Output target maintain karna")), /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__block"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__sh"
    }, "Chahiye"), /*#__PURE__*/React.createElement("div", {
      className: "aw-chips"
    }, /*#__PURE__*/React.createElement("span", {
      className: "aw-tag"
    }, "Fanuc control"), /*#__PURE__*/React.createElement("span", {
      className: "aw-tag"
    }, "2+ yrs"), /*#__PURE__*/React.createElement("span", {
      className: "aw-tag"
    }, "ITI / diploma"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__block",
      style: {
        border: 'none'
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__sh"
    }, "Faayde"), /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__li"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-check-circle"
    }), " PF + ESI + overtime"), /*#__PURE__*/React.createElement("div", {
      className: "aw-jd__li"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-check-circle"
    }), " Canteen + transport"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-stickycta"
    }, /*#__PURE__*/React.createElement("button", {
      className: "aw-skip",
      onClick: () => go('feed')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-x"
    })), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--go",
      style: {
        flex: 1
      },
      onClick: () => go('applied')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-bold ph-check"
    }), " Apply karein")));
  }

  /* 13 · Filters (sheet over feed) */
  function Filters({
    go
  }) {
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-feed__hd"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-feed__eb"
    }, "Jobs near you"), /*#__PURE__*/React.createElement("div", {
      className: "aw-feed__loc"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-map-pin"
    }), " Pune \xB7 15 km")), /*#__PURE__*/React.createElement("div", {
      className: "aw-body",
      style: {
        filter: 'blur(1px)',
        opacity: .5
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-deck"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-job",
      style: {
        minHeight: 280
      }
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-sheetwrap"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-sheet"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-sheet__grip"
    }), /*#__PURE__*/React.createElement("h3", {
      className: "aw-sheet__h"
    }, "Filter jobs"), /*#__PURE__*/React.createElement("div", {
      className: "aw-fgroup"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-fgroup__l"
    }, "Trade"), /*#__PURE__*/React.createElement("div", {
      className: "aw-chips"
    }, /*#__PURE__*/React.createElement("span", {
      className: "aw-chip is-on"
    }, "CNC"), /*#__PURE__*/React.createElement("span", {
      className: "aw-chip is-on"
    }, "VMC"), /*#__PURE__*/React.createElement("span", {
      className: "aw-chip"
    }, "Welder"), /*#__PURE__*/React.createElement("span", {
      className: "aw-chip"
    }, "Fitter"), /*#__PURE__*/React.createElement("span", {
      className: "aw-chip"
    }, "QC"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-fgroup"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-fgroup__l"
    }, "Distance"), /*#__PURE__*/React.createElement("div", {
      className: "aw-chips"
    }, /*#__PURE__*/React.createElement("span", {
      className: "aw-chip"
    }, "5 km"), /*#__PURE__*/React.createElement("span", {
      className: "aw-chip is-on"
    }, "15 km"), /*#__PURE__*/React.createElement("span", {
      className: "aw-chip"
    }, "30 km"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-fgroup"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-fgroup__l"
    }, "Shift"), /*#__PURE__*/React.createElement("div", {
      className: "aw-chips"
    }, /*#__PURE__*/React.createElement("span", {
      className: "aw-chip is-on"
    }, "Day"), /*#__PURE__*/React.createElement("span", {
      className: "aw-chip"
    }, "Night"), /*#__PURE__*/React.createElement("span", {
      className: "aw-chip"
    }, "Rotational"))), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--go",
      onClick: () => go('feed')
    }, "Show 24 jobs"))));
  }

  /* 14 · Applied */
  function Applied({
    go
  }) {
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-body"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-applied"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-stamp"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-bold ph-check"
    })), /*#__PURE__*/React.createElement("h2", {
      style: {
        fontFamily: 'var(--font-display)',
        fontWeight: 800,
        fontSize: 26,
        margin: 0
      }
    }, "Apply ho gaya!"), /*#__PURE__*/React.createElement("p", {
      className: "aw-muted"
    }, "Sharma Precision Works ko aapka profile bhej diya. Reply aane par hum aapko batayenge.")), /*#__PURE__*/React.createElement("div", {
      className: "aw-pad",
      style: {
        paddingTop: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-card",
      style: {
        padding: 0,
        marginBottom: 16
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-status-row"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-status-row__ic is-green"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-paper-plane-right"
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", {
      style: {
        color: 'var(--text-primary)'
      }
    }, "Applied"), /*#__PURE__*/React.createElement("div", {
      className: "aw-muted"
    }, "Abhi \xB7 CNC Operator"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-status-row",
      style: {
        borderTop: '1px solid var(--divider)'
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-status-row__ic is-saffron"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-eye"
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", {
      style: {
        color: 'var(--text-primary)'
      }
    }, "Employer ne dekha"), /*#__PURE__*/React.createElement("div", {
      className: "aw-muted"
    }, "Pending")))), /*#__PURE__*/React.createElement("button", {
      className: "aw-btn aw-btn--go",
      onClick: () => go('feed')
    }, "Aur jobs dekhein ", /*#__PURE__*/React.createElement("i", {
      className: "ph-bold ph-arrow-right"
    })))), /*#__PURE__*/React.createElement(Nav, {
      tab: 'feed',
      go: go
    }));
  }

  /* 15 · Profile */
  function Profile({
    go,
    tab
  }) {
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__t"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__title",
      style: {
        fontSize: 26
      }
    }, "Profile")), /*#__PURE__*/React.createElement("button", {
      className: "aw-iconbtn",
      onClick: () => go('settings')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-gear"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-body aw-pad",
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-prof__head"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-prof__av"
    }, "RK", /*#__PURE__*/React.createElement("span", {
      className: "aw-prof__seal"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-seal-check"
    }))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "aw-prof__name"
    }, "Ramesh Kumar"), /*#__PURE__*/React.createElement("div", {
      className: "aw-muted"
    }, "CNC Operator \xB7 Pune"), /*#__PURE__*/React.createElement("span", {
      className: "aw-badge-verified",
      style: {
        marginTop: 6
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-seal-check"
    }), " Verified"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-card"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 14,
        fontWeight: 700,
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement("span", null, "Profile strength"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)'
      }
    }, "72%")), /*#__PURE__*/React.createElement("div", {
      className: "aw-prog"
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: '72%'
      }
    })), /*#__PURE__*/React.createElement("p", {
      className: "aw-muted",
      style: {
        marginTop: 10
      }
    }, "Ek photo add karein aur 100% tak pahunchein.")), /*#__PURE__*/React.createElement("div", {
      className: "aw-card aw-kit",
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        cursor: 'pointer'
      },
      onClick: () => go('kit')
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-kitrow__ic"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-exam"
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-card__h"
    }, "Interview kit"), /*#__PURE__*/React.createElement("div", {
      className: "aw-muted"
    }, "15 sawaal + jawaab")), /*#__PURE__*/React.createElement("i", {
      className: "ph ph-caret-right",
      style: {
        color: 'var(--text-faint)'
      }
    }))), /*#__PURE__*/React.createElement(Nav, {
      tab: tab || 'profile',
      go: go
    }));
  }

  /* 16 · Settings */
  function Settings({
    go
  }) {
    const rows = [['translate', 'Bhasha', 'हिंदी', 0], ['whatsapp-logo', 'WhatsApp alerts', 'Job alert · resume · reply', 0], ['bell', 'Notifications', 'On', 0], ['shield-check', 'Privacy & data', 'Consent · download · delete', 0], ['trash', 'Account delete karein', 'OTP ke baad 7 din mein', 1]];
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar"
    }, /*#__PURE__*/React.createElement("button", {
      className: "aw-back",
      onClick: () => go('profile')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-arrow-left"
    })), /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__t"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__title"
    }, "Settings"))), /*#__PURE__*/React.createElement("div", {
      className: "aw-body aw-pad"
    }, rows.map(([ic, t, s, danger]) => /*#__PURE__*/React.createElement("div", {
      className: 'aw-srow' + (danger ? ' aw-srow--danger' : ''),
      key: t
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-srow__ic"
    }, /*#__PURE__*/React.createElement("i", {
      className: 'ph ph-' + ic
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", null, t), /*#__PURE__*/React.createElement("small", null, s)), /*#__PURE__*/React.createElement("i", {
      className: "ph ph-caret-right aw-srow__chev"
    }))), /*#__PURE__*/React.createElement("p", {
      className: "aw-legal",
      style: {
        marginTop: 20
      }
    }, "BadaBhai \xB7 v1.0 \xB7 Made in India \uD83C\uDDEE\uD83C\uDDF3")));
  }

  /* 17 · Notifications / alerts */
  function Notifications({
    go,
    tab
  }) {
    const N = [['green', 'briefcase', 'Naya job — CNC Operator', 'Sharma Precision Works · Pimpri · ₹22–28k', 'Abhi'], ['saffron', 'eye', 'Employer ne aapka profile dekha', 'Deccan Auto Components', '2 ghante'], ['brand', 'file-text', 'Aapka resume taiyaar hai', 'Download ya WhatsApp pe share karein', 'Kal']];
    const bg = {
      green: 'is-green',
      saffron: 'is-saffron',
      brand: ''
    };
    return /*#__PURE__*/React.createElement(Device, null, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__t"
    }, /*#__PURE__*/React.createElement("div", {
      className: "aw-bar__title"
    }, "Alerts")), /*#__PURE__*/React.createElement("button", {
      className: "aw-iconbtn"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-check"
    }))), /*#__PURE__*/React.createElement("div", {
      className: "aw-body aw-pad"
    }, N.map(([c, ic, t, p, time], i) => /*#__PURE__*/React.createElement("div", {
      className: "aw-noti",
      key: i
    }, /*#__PURE__*/React.createElement("div", {
      className: 'aw-noti__ic ' + (bg[c] || ''),
      style: c === 'brand' ? {
        background: 'var(--vermilion-50)',
        color: 'var(--brand)'
      } : {}
    }, /*#__PURE__*/React.createElement("i", {
      className: 'ph-fill ph-' + ic
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("b", null, t), /*#__PURE__*/React.createElement("p", null, p)), /*#__PURE__*/React.createElement("small", {
      className: "aw-muted"
    }, time)))), /*#__PURE__*/React.createElement(Nav, {
      tab: tab || 'notifications',
      go: go
    }));
  }
  window.AW = {
    Device,
    Logo,
    Nav,
    screens: {
      splash: Splash,
      phone: Phone,
      otp: Otp,
      consent: Consent,
      chat: Chat,
      building: Building,
      resume: Resume,
      resumeEdit: ResumeEdit,
      kit: Kit,
      kitDetail: KitDetail,
      feed: Feed,
      jobDetail: JobDetail,
      filters: Filters,
      applied: Applied,
      profile: Profile,
      settings: Settings,
      notifications: Notifications
    },
    order: [['splash', '01 Splash + language', 'First open — language first, no test'], ['phone', '02 Phone', 'Phone number entry'], ['otp', '03 OTP', '4-digit verification'], ['consent', '04 Consent', 'DPDP + model-training consent gate'], ['chat', '05 Chat onboarding', 'Bada bhai profiles you + form pop-up'], ['building', '06 Building', 'Generating the resume'], ['resume', '07 Resume ready', 'Free branded resume + share'], ['resumeEdit', '08 Resume edit', 'Safe fields the worker controls'], ['kit', '09 Interview kit', 'Per-trade Q&A list'], ['kitDetail', '10 Interview kit detail', 'Questions + answers'], ['feed', '11 Job feed', 'Swipe-to-apply'], ['jobDetail', '12 Job detail', 'Full posting'], ['filters', '13 Filters', 'Trade / distance / shift sheet'], ['applied', '14 Applied', 'Application confirmed + status'], ['profile', '15 Profile', 'Strength + verified + kit'], ['settings', '16 Settings', 'Language · WhatsApp · privacy · delete'], ['notifications', '17 Alerts', 'Jobs · views · resume nudges']]
  };
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "android-build-kit/screens.jsx", error: String((e && e.message) || e) }); }

// components/brand/BadaBhaiLogo.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** The BadaBhai logo — chat-lift mark + Baloo 2 wordmark. Mark SVG is inlined (no asset path). */
function BadaBhaiLogo({
  variant = 'full',
  theme = 'paper',
  size = 32,
  className = '',
  ...rest
}) {
  const mark = /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 512 512",
    width: size,
    height: size,
    className: "bb-logo__mark",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("rect", {
    width: "512",
    height: "512",
    rx: "128",
    fill: "#E0371C"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M150 124h212a40 40 0 0 1 40 40v132a40 40 0 0 1-40 40H252l-78 62a12 12 0 0 1-19.4-9.4V336h-4.6a40 40 0 0 1-40-40V164a40 40 0 0 1 40-40Z",
    fill: "#FFFFFF"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M196 268l60-58 60 58",
    stroke: "#0E7A4F",
    strokeWidth: "32",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    fill: "none"
  }));
  return /*#__PURE__*/React.createElement("span", _extends({
    className: ['bb-logo', `bb-logo--${theme}`, className].filter(Boolean).join(' '),
    role: "img",
    "aria-label": "BadaBhai"
  }, rest), variant !== 'wordmark' && mark, variant !== 'mark' && /*#__PURE__*/React.createElement("span", {
    className: "bb-logo__word",
    style: {
      fontSize: Math.round(size * 0.92)
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "bb-logo__a"
  }, "Bada"), /*#__PURE__*/React.createElement("span", {
    className: "bb-logo__b"
  }, "Bhai")));
}
Object.assign(__ds_scope, { BadaBhaiLogo });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/BadaBhaiLogo.jsx", error: String((e && e.message) || e) }); }

// components/brand/ChatBubble.jsx
try { (() => {
const WAVE = [10, 16, 8, 20, 12, 18, 7, 22, 9, 15, 11, 17, 8];

/** A single chat message — the heart of the chat-first worker app. Bot = bada bhai. */
function ChatBubble({
  from = 'bot',
  children,
  time,
  voice = false,
  duration = '0:12',
  showAvatar = true,
  className = ''
}) {
  const isUser = from === 'user';
  return /*#__PURE__*/React.createElement("div", {
    className: `bb-chat bb-chat--${isUser ? 'user' : 'bot'} ${className}`.trim()
  }, !isUser && showAvatar && /*#__PURE__*/React.createElement("span", {
    className: "bb-chat__avatar"
  }, /*#__PURE__*/React.createElement(__ds_scope.BadaBhaiLogo, {
    variant: "mark",
    size: 28
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "bb-chat__bubble"
  }, voice ? /*#__PURE__*/React.createElement("div", {
    className: "bb-chat__voice"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bb-chat__play"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph-fill ph-play",
    "aria-hidden": "true"
  })), /*#__PURE__*/React.createElement("span", {
    className: "bb-chat__wave"
  }, WAVE.map((h, i) => /*#__PURE__*/React.createElement("i", {
    key: i,
    style: {
      height: h
    }
  }))), /*#__PURE__*/React.createElement("span", {
    className: "bb-chat__dur"
  }, duration)) : children), time && /*#__PURE__*/React.createElement("span", {
    className: "bb-chat__time"
  }, time)));
}
Object.assign(__ds_scope, { ChatBubble });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/ChatBubble.jsx", error: String((e && e.message) || e) }); }

// components/brand/JobCard.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** The swipe-to-apply job card — the core worker-app surface. Right = apply, left = skip. */
function JobCard({
  title,
  company,
  companyLogo,
  verified = true,
  location,
  shift,
  salary,
  tags = [],
  vacanciesLeft,
  onApply,
  onSkip,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['bb-jobcard', className].filter(Boolean).join(' ')
  }, rest), /*#__PURE__*/React.createElement("div", {
    className: "bb-jobcard__top"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "bb-jobcard__title"
  }, title), /*#__PURE__*/React.createElement("div", {
    className: "bb-jobcard__company"
  }, company, verified && /*#__PURE__*/React.createElement("i", {
    className: "ph-fill ph-seal-check",
    style: {
      color: 'var(--success)'
    },
    "aria-label": "Verified"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "bb-jobcard__logo"
  }, companyLogo ? /*#__PURE__*/React.createElement("img", {
    src: companyLogo,
    alt: company
  }) : /*#__PURE__*/React.createElement("i", {
    className: "ph ph-buildings",
    "aria-hidden": "true"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "bb-jobcard__facts"
  }, location && /*#__PURE__*/React.createElement("span", {
    className: "bb-jobcard__fact"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-map-pin",
    "aria-hidden": "true"
  }), location), shift && /*#__PURE__*/React.createElement("span", {
    className: "bb-jobcard__fact"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-clock",
    "aria-hidden": "true"
  }), shift), salary && /*#__PURE__*/React.createElement("span", {
    className: "bb-jobcard__fact"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-currency-inr",
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("span", {
    className: "bb-jobcard__salary"
  }, salary))), tags.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "bb-jobcard__tags"
  }, tags.map((t, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: "bb-badge bb-badge--neutral"
  }, t))), vacanciesLeft != null && /*#__PURE__*/React.createElement("div", {
    className: "bb-jobcard__quota"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-users-three",
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("b", null, vacanciesLeft, " spots"), " left of this opening"), /*#__PURE__*/React.createElement("div", {
    className: "bb-jobcard__foot"
  }, /*#__PURE__*/React.createElement("button", {
    className: "bb-jobcard__skipbtn",
    onClick: onSkip,
    "aria-label": "Skip"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-x",
    "aria-hidden": "true"
  })), /*#__PURE__*/React.createElement("button", {
    className: "bb-btn bb-btn--primary bb-btn--lg",
    style: {
      flex: 1
    },
    onClick: onApply
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-check",
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("span", null, "Apply"))));
}
Object.assign(__ds_scope, { JobCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/JobCard.jsx", error: String((e && e.message) || e) }); }

// components/brand/MaskedCandidate.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Payer-side candidate row — masked until unlocked for ₹40. The product's core privacy motif. */
function MaskedCandidate({
  name = 'Candidate',
  trade,
  experience,
  location,
  verified = true,
  masked = true,
  price = '₹40',
  matchLabel,
  onUnlock,
  className = '',
  ...rest
}) {
  const initials = name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['bb-candidate', masked ? 'bb-candidate--masked' : '', className].filter(Boolean).join(' ')
  }, rest), /*#__PURE__*/React.createElement("span", {
    className: `bb-avatar ${masked ? 'bb-avatar--masked' : 'bb-avatar--brand'}`,
    style: {
      width: 52,
      height: 52,
      fontSize: 20
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "bb-avatar__initials"
  }, masked ? '••' : initials || '?'), verified && /*#__PURE__*/React.createElement("span", {
    className: "bb-avatar__seal"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph-fill ph-seal-check",
    "aria-hidden": "true"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "bb-candidate__body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bb-candidate__name"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bb-candidate__name-text"
  }, masked ? 'Ramesh K.' : name), verified && /*#__PURE__*/React.createElement("i", {
    className: "ph-fill ph-seal-check",
    style: {
      color: 'var(--success)',
      fontSize: 16
    },
    "aria-label": "Verified"
  })), /*#__PURE__*/React.createElement("div", {
    className: "bb-candidate__meta"
  }, trade && /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-wrench",
    "aria-hidden": "true"
  }), trade), experience && /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-medal",
    "aria-hidden": "true"
  }), experience), location && /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-map-pin",
    "aria-hidden": "true"
  }), location))), /*#__PURE__*/React.createElement("div", {
    className: "bb-candidate__action"
  }, matchLabel && /*#__PURE__*/React.createElement("span", {
    className: "bb-badge bb-badge--success"
  }, matchLabel), masked ? /*#__PURE__*/React.createElement("button", {
    className: "bb-btn bb-btn--primary",
    onClick: onUnlock
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-lock-key-open",
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("span", null, price)) : /*#__PURE__*/React.createElement("span", {
    className: "bb-candidate__unlocked"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph-fill ph-lock-key-open",
    "aria-hidden": "true"
  }), "Unlocked")));
}
Object.assign(__ds_scope, { MaskedCandidate });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/MaskedCandidate.jsx", error: String((e && e.message) || e) }); }

// components/display/Avatar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Worker avatar with initials fallback, optional blur mask and a verified seal. */
function Avatar({
  src,
  name = '',
  size = 44,
  masked = false,
  verified = false,
  brand = false,
  className = '',
  ...rest
}) {
  const initials = name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const cls = ['bb-avatar', masked ? 'bb-avatar--masked' : '', brand ? 'bb-avatar--brand' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls,
    style: {
      width: size,
      height: size,
      fontSize: Math.round(size * 0.4)
    }
  }, rest), src ? /*#__PURE__*/React.createElement("img", {
    className: "bb-avatar__img",
    src: src,
    alt: name
  }) : /*#__PURE__*/React.createElement("span", {
    className: "bb-avatar__initials"
  }, initials || '?'), verified && /*#__PURE__*/React.createElement("span", {
    className: "bb-avatar__seal"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph-fill ph-seal-check",
    "aria-hidden": "true"
  })));
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/display/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Small status pill — VERIFIED, PAUSED, “2 left”, trade tags. */
function Badge({
  tone = 'neutral',
  variant = 'soft',
  upper = false,
  icon,
  className = '',
  children,
  ...rest
}) {
  const cls = ['bb-badge', `bb-badge--${tone}`, variant !== 'soft' ? `bb-badge--${variant}` : '', upper ? 'bb-badge--upper' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("span", _extends({
    className: cls
  }, rest), icon && /*#__PURE__*/React.createElement("i", {
    className: `ph-fill ph-${icon}`,
    "aria-hidden": "true"
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Badge.jsx", error: String((e && e.message) || e) }); }

// components/display/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Surface container — the warm white card on paper that holds most content. */
function Card({
  variant = 'default',
  padding = 'md',
  interactive = false,
  as: Tag = 'div',
  className = '',
  children,
  ...rest
}) {
  const cls = ['bb-card', variant !== 'default' ? `bb-card--${variant}` : '', padding !== 'md' ? `bb-card--pad-${padding}` : '', interactive ? 'bb-card--interactive' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement(Tag, _extends({
    className: cls
  }, rest), children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Card.jsx", error: String((e && e.message) || e) }); }

// components/display/Chip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Selectable pill — trade filters, skills, languages. Marigold when selected. */
function Chip({
  selected = false,
  icon,
  onRemove,
  className = '',
  children,
  ...rest
}) {
  const cls = ['bb-chip', selected ? 'bb-chip--selected' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    className: cls,
    "aria-pressed": selected
  }, rest), icon && /*#__PURE__*/React.createElement("i", {
    className: `ph ph-${icon}`,
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("span", null, children), onRemove && /*#__PURE__*/React.createElement("span", {
    className: "bb-chip__remove",
    role: "button",
    "aria-label": "Remove",
    onClick: e => {
      e.stopPropagation();
      onRemove(e);
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-x",
    "aria-hidden": "true"
  })));
}
Object.assign(__ds_scope, { Chip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/Chip.jsx", error: String((e && e.message) || e) }); }

// components/display/StatTile.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Dashboard metric tile — label, big mono value, optional delta. Payer side. */
function StatTile({
  label,
  value,
  icon,
  delta,
  deltaDir = 'up',
  className = '',
  ...rest
}) {
  const arrow = deltaDir === 'up' ? 'trend-up' : deltaDir === 'down' ? 'trend-down' : 'minus';
  return /*#__PURE__*/React.createElement("div", _extends({
    className: ['bb-stat', className].filter(Boolean).join(' ')
  }, rest), /*#__PURE__*/React.createElement("div", {
    className: "bb-stat__head"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bb-stat__label"
  }, label), icon && /*#__PURE__*/React.createElement("span", {
    className: "bb-stat__icon"
  }, /*#__PURE__*/React.createElement("i", {
    className: `ph ph-${icon}`,
    "aria-hidden": "true"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "bb-stat__value"
  }, value), delta != null && /*#__PURE__*/React.createElement("div", {
    className: `bb-stat__delta bb-stat__delta--${deltaDir}`
  }, /*#__PURE__*/React.createElement("i", {
    className: `ph-bold ph-${arrow}`,
    "aria-hidden": "true"
  }), delta));
}
Object.assign(__ds_scope, { StatTile });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/display/StatTile.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Dialog.jsx
try { (() => {
/** Modal dialog (centered) or bottom sheet. Controlled via `open`. */
function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  sheet = false,
  closeOnScrim = true
}) {
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = e => {
      if (e.key === 'Escape' && onClose) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: `bb-scrim ${sheet ? 'bb-scrim--sheet' : ''}`,
    onClick: closeOnScrim ? e => {
      if (e.target === e.currentTarget && onClose) onClose();
    } : undefined
  }, /*#__PURE__*/React.createElement("div", {
    className: `bb-dialog ${sheet ? 'bb-dialog--sheet' : ''}`,
    role: "dialog",
    "aria-modal": "true"
  }, (title || onClose) && /*#__PURE__*/React.createElement("div", {
    className: "bb-dialog__head"
  }, title && /*#__PURE__*/React.createElement("h3", {
    className: "bb-dialog__title"
  }, title), onClose && /*#__PURE__*/React.createElement("button", {
    className: "bb-iconbtn",
    "aria-label": "Close",
    onClick: onClose
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-x",
    "aria-hidden": "true"
  }))), children && /*#__PURE__*/React.createElement("div", {
    className: "bb-dialog__body"
  }, children), footer && /*#__PURE__*/React.createElement("div", {
    className: "bb-dialog__foot"
  }, footer)));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/feedback/ProgressBar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Linear progress — resume completion, profile strength, vacancy-quota fill. */
function ProgressBar({
  value = 0,
  label,
  showValue = false,
  tone = 'brand',
  thick = false,
  className = '',
  ...rest
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const cls = ['bb-progress', tone !== 'brand' ? `bb-progress--${tone}` : '', thick ? 'bb-progress--thick' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls
  }, rest), (label || showValue) && /*#__PURE__*/React.createElement("div", {
    className: "bb-progress__head"
  }, /*#__PURE__*/React.createElement("span", null, label), showValue && /*#__PURE__*/React.createElement("span", {
    className: "bb-progress__pct"
  }, pct, "%")), /*#__PURE__*/React.createElement("div", {
    className: "bb-progress__track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bb-progress__fill",
    style: {
      width: `${pct}%`
    },
    role: "progressbar",
    "aria-valuenow": pct,
    "aria-valuemin": 0,
    "aria-valuemax": 100
  })));
}
Object.assign(__ds_scope, { ProgressBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/ProgressBar.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Toast.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const DEFAULT_ICON = {
  success: 'check-circle',
  danger: 'warning-circle',
  brand: 'sparkle',
  neutral: 'info'
};

/** Toast notification on a dark ink surface. Present in a stack at a screen corner. */
function Toast({
  tone = 'neutral',
  icon,
  title,
  children,
  onClose,
  className = '',
  ...rest
}) {
  const cls = ['bb-toast', tone !== 'neutral' ? `bb-toast--${tone}` : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls,
    role: "status"
  }, rest), /*#__PURE__*/React.createElement("i", {
    className: `ph-fill ph-${icon || DEFAULT_ICON[tone]} bb-toast__icon`,
    "aria-hidden": "true"
  }), /*#__PURE__*/React.createElement("div", {
    className: "bb-toast__content"
  }, title && /*#__PURE__*/React.createElement("div", {
    className: "bb-toast__title"
  }, title), children && /*#__PURE__*/React.createElement("div", {
    className: "bb-toast__msg"
  }, children)), onClose && /*#__PURE__*/React.createElement("button", {
    className: "bb-toast__close",
    "aria-label": "Dismiss",
    onClick: onClose
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-x",
    "aria-hidden": "true"
  })));
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Toast.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Tooltip.jsx
try { (() => {
/** Hover/focus tooltip on a dark ink bubble. Wraps a single trigger element. */
function Tooltip({
  label,
  placement = 'top',
  children
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: "bb-tooltip-wrap",
    tabIndex: 0
  }, children, /*#__PURE__*/React.createElement("span", {
    className: `bb-tooltip bb-tooltip--${placement}`,
    role: "tooltip"
  }, label));
}
Object.assign(__ds_scope, { Tooltip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Tooltip.jsx", error: String((e && e.message) || e) }); }

// components/forms/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * BadaBhai primary action button.
 * Marigold `primary` is the one CTA per screen; everything else is quieter.
 */
function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  iconLeft,
  iconRight,
  loading = false,
  disabled = false,
  type = 'button',
  className = '',
  children,
  ...rest
}) {
  const cls = ['bb-btn', `bb-btn--${variant}`, size !== 'md' ? `bb-btn--${size}` : '', block ? 'bb-btn--block' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    className: cls,
    disabled: disabled || loading
  }, rest), loading && /*#__PURE__*/React.createElement("span", {
    className: "bb-btn__spinner",
    "aria-hidden": "true"
  }), !loading && iconLeft && /*#__PURE__*/React.createElement("i", {
    className: `ph ph-${iconLeft}`,
    "aria-hidden": "true"
  }), children != null && /*#__PURE__*/React.createElement("span", null, children), !loading && iconRight && /*#__PURE__*/React.createElement("i", {
    className: `ph ph-${iconRight}`,
    "aria-hidden": "true"
  }));
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Button.jsx", error: String((e && e.message) || e) }); }

// components/forms/Checkbox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Checkbox with a marigold fill and a Phosphor check on select. */
function Checkbox({
  label,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: ['bb-choice', 'bb-choice--checkbox', className].filter(Boolean).join(' ')
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox"
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "bb-choice__box"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph-bold ph-check",
    "aria-hidden": "true"
  })), label != null && /*#__PURE__*/React.createElement("span", {
    className: "bb-choice__label"
  }, label));
}
Object.assign(__ds_scope, { Checkbox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Checkbox.jsx", error: String((e && e.message) || e) }); }

// components/forms/IconButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Square icon-only button. Always pass `label` for accessibility (worker app pairs icons with text labels elsewhere). */
function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  className = '',
  ...rest
}) {
  const cls = ['bb-iconbtn', variant !== 'ghost' ? `bb-iconbtn--${variant}` : '', size !== 'md' ? `bb-iconbtn--${size}` : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    className: cls,
    "aria-label": label,
    title: label
  }, rest), /*#__PURE__*/React.createElement("i", {
    className: `ph ph-${icon}`,
    "aria-hidden": "true"
  }));
}
Object.assign(__ds_scope, { IconButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/IconButton.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
let _id = 0;

/** Text input with label, hint/error, and optional leading/trailing Phosphor icons. */
function Input({
  label,
  hint,
  error,
  iconLeft,
  iconRight,
  optional = false,
  id,
  className = '',
  ...rest
}) {
  const inputId = id || `bb-input-${++_id}`;
  const cls = ['bb-input', iconLeft ? 'bb-input--has-left' : '', iconRight ? 'bb-input--has-right' : '', error ? 'bb-input--error' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", {
    className: "bb-field"
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "bb-field__label",
    htmlFor: inputId
  }, label, optional && /*#__PURE__*/React.createElement("span", {
    className: "bb-field__opt"
  }, " \xB7 optional")), /*#__PURE__*/React.createElement("div", {
    className: "bb-input-wrap"
  }, iconLeft && /*#__PURE__*/React.createElement("span", {
    className: "bb-input__icon bb-input__icon--left"
  }, /*#__PURE__*/React.createElement("i", {
    className: `ph ph-${iconLeft}`,
    "aria-hidden": "true"
  })), /*#__PURE__*/React.createElement("input", _extends({
    id: inputId,
    className: cls
  }, rest)), iconRight && /*#__PURE__*/React.createElement("span", {
    className: "bb-input__icon bb-input__icon--right"
  }, /*#__PURE__*/React.createElement("i", {
    className: `ph ph-${iconRight}`,
    "aria-hidden": "true"
  }))), error ? /*#__PURE__*/React.createElement("span", {
    className: "bb-field__error"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-warning-circle",
    "aria-hidden": "true"
  }), error) : hint ? /*#__PURE__*/React.createElement("span", {
    className: "bb-field__hint"
  }, hint) : null);
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/OtpInput.jsx
try { (() => {
/** Controlled OTP entry — N single-digit cells with auto-advance and backspace nav. */
function OtpInput({
  length = 4,
  value = '',
  onChange,
  autoFocus = false
}) {
  const refs = React.useRef([]);
  const chars = Array.from({
    length
  }, (_, i) => value[i] || '');
  const setChar = (i, c) => {
    const next = chars.slice();
    next[i] = c;
    onChange && onChange(next.join(''));
  };
  const handleChange = (i, e) => {
    const v = e.target.value.replace(/\D/g, '');
    if (!v) {
      setChar(i, '');
      return;
    }
    setChar(i, v[v.length - 1]);
    if (i < length - 1 && refs.current[i + 1]) refs.current[i + 1].focus();
  };
  const handleKey = (i, e) => {
    if (e.key === 'Backspace' && !chars[i] && i > 0) refs.current[i - 1].focus();
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "bb-otp",
    role: "group",
    "aria-label": "One-time passcode"
  }, chars.map((c, i) => /*#__PURE__*/React.createElement("input", {
    key: i,
    ref: el => refs.current[i] = el,
    className: `bb-otp__cell ${c ? 'bb-otp__cell--filled' : ''}`,
    inputMode: "numeric",
    maxLength: 1,
    value: c,
    autoFocus: autoFocus && i === 0,
    onChange: e => handleChange(i, e),
    onKeyDown: e => handleKey(i, e)
  })));
}
Object.assign(__ds_scope, { OtpInput });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/OtpInput.jsx", error: String((e && e.message) || e) }); }

// components/forms/Radio.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Radio with a marigold dot. Group with a shared `name`. */
function Radio({
  label,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: ['bb-choice', 'bb-choice--radio', className].filter(Boolean).join(' ')
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "radio"
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "bb-choice__box"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bb-choice__dot",
    "aria-hidden": "true"
  })), label != null && /*#__PURE__*/React.createElement("span", {
    className: "bb-choice__label"
  }, label));
}
Object.assign(__ds_scope, { Radio });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Radio.jsx", error: String((e && e.message) || e) }); }

// components/forms/Select.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
let _id = 0;

/** Native select, restyled with a marigold focus ring and a Phosphor chevron. */
function Select({
  label,
  hint,
  error,
  optional = false,
  id,
  className = '',
  children,
  ...rest
}) {
  const sid = id || `bb-select-${++_id}`;
  const cls = ['bb-input', 'bb-select', error ? 'bb-input--error' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", {
    className: "bb-field"
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "bb-field__label",
    htmlFor: sid
  }, label, optional && /*#__PURE__*/React.createElement("span", {
    className: "bb-field__opt"
  }, " \xB7 optional")), /*#__PURE__*/React.createElement("div", {
    className: "bb-select-wrap"
  }, /*#__PURE__*/React.createElement("select", _extends({
    id: sid,
    className: cls
  }, rest), children), /*#__PURE__*/React.createElement("span", {
    className: "bb-select__chevron"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-caret-down",
    "aria-hidden": "true"
  }))), error ? /*#__PURE__*/React.createElement("span", {
    className: "bb-field__error"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-warning-circle",
    "aria-hidden": "true"
  }), error) : hint ? /*#__PURE__*/React.createElement("span", {
    className: "bb-field__hint"
  }, hint) : null);
}
Object.assign(__ds_scope, { Select });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Select.jsx", error: String((e && e.message) || e) }); }

// components/forms/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Toggle switch — turns verified-green when on. For on/off settings. */
function Switch({
  label,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: ['bb-switch', className].filter(Boolean).join(' ')
  }, /*#__PURE__*/React.createElement("input", _extends({
    type: "checkbox",
    role: "switch"
  }, rest)), /*#__PURE__*/React.createElement("span", {
    className: "bb-switch__track"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bb-switch__thumb"
  })), label != null && /*#__PURE__*/React.createElement("span", {
    className: "bb-switch__label"
  }, label));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Switch.jsx", error: String((e && e.message) || e) }); }

// components/forms/Textarea.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
let _id = 0;

/** Multi-line text input. Same shell as Input; vertically resizable. */
function Textarea({
  label,
  hint,
  error,
  optional = false,
  rows = 4,
  id,
  className = '',
  ...rest
}) {
  const taId = id || `bb-textarea-${++_id}`;
  const cls = ['bb-input', 'bb-textarea', error ? 'bb-input--error' : '', className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", {
    className: "bb-field"
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "bb-field__label",
    htmlFor: taId
  }, label, optional && /*#__PURE__*/React.createElement("span", {
    className: "bb-field__opt"
  }, " \xB7 optional")), /*#__PURE__*/React.createElement("textarea", _extends({
    id: taId,
    className: cls,
    rows: rows
  }, rest)), error ? /*#__PURE__*/React.createElement("span", {
    className: "bb-field__error"
  }, /*#__PURE__*/React.createElement("i", {
    className: "ph ph-warning-circle",
    "aria-hidden": "true"
  }), error) : hint ? /*#__PURE__*/React.createElement("span", {
    className: "bb-field__hint"
  }, hint) : null);
}
Object.assign(__ds_scope, { Textarea });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Textarea.jsx", error: String((e && e.message) || e) }); }

// components/navigation/BottomNav.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Worker-app bottom tab bar. Active tab is marigold with a filled icon. */
function BottomNav({
  items = [],
  value,
  onChange,
  className = '',
  ...rest
}) {
  return /*#__PURE__*/React.createElement("nav", _extends({
    className: ['bb-bottomnav', className].filter(Boolean).join(' ')
  }, rest), items.map(it => {
    const active = value === it.id;
    return /*#__PURE__*/React.createElement("button", {
      key: it.id,
      className: `bb-bottomnav__item ${active ? 'bb-bottomnav__item--active' : ''}`,
      onClick: () => onChange && onChange(it.id),
      "aria-current": active ? 'page' : undefined
    }, /*#__PURE__*/React.createElement("i", {
      className: `${active ? 'ph-fill' : 'ph'} ph-${it.icon}`,
      "aria-hidden": "true"
    }), it.badge != null && /*#__PURE__*/React.createElement("span", {
      className: "bb-bottomnav__badge"
    }, it.badge), /*#__PURE__*/React.createElement("span", null, it.label));
  }));
}
Object.assign(__ds_scope, { BottomNav });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/BottomNav.jsx", error: String((e && e.message) || e) }); }

// components/navigation/Tabs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Tab bar — underline (page sections) or segmented (filters / role views). */
function Tabs({
  tabs = [],
  value,
  onChange,
  variant = 'underline',
  className = '',
  ...rest
}) {
  const cls = ['bb-tabs', `bb-tabs--${variant}`, className].filter(Boolean).join(' ');
  return /*#__PURE__*/React.createElement("div", _extends({
    className: cls,
    role: "tablist"
  }, rest), tabs.map(t => {
    const active = value === t.id;
    return /*#__PURE__*/React.createElement("button", {
      key: t.id,
      role: "tab",
      "aria-selected": active,
      className: `bb-tab ${active ? 'bb-tab--active' : ''}`,
      onClick: () => onChange && onChange(t.id)
    }, t.icon && /*#__PURE__*/React.createElement("i", {
      className: `${active ? 'ph-fill' : 'ph'} ph-${t.icon}`,
      "aria-hidden": "true"
    }), t.label);
  }));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/Tabs.jsx", error: String((e && e.message) || e) }); }

// ui_kits/company-web/app.jsx
try { (() => {
(function () {
  const {
    Toast
  } = window.BadaBhaiDesignSystem_01ff85;

  /* Role-aware controller. Company & Agency share the demand loop; Agency adds a
     parked Earnings view (supply dashboard is the post-alpha fast-follow). */
  function CompanyWebApp() {
    const [role, setRole] = React.useState('company');
    const [view, setView] = React.useState('dashboard');
    const [credits, setCredits] = React.useState(184);
    const [unlocked, setUnlocked] = React.useState(() => new Set());
    const [postedToast, setPostedToast] = React.useState(false);
    const handleUnlock = id => {
      setUnlocked(prev => {
        const n = new Set(prev);
        n.add(id);
        return n;
      });
      setCredits(c => Math.max(0, c - 1));
    };
    const handleRole = r => {
      setRole(r);
      if (r === 'company' && view === 'earnings') setView('dashboard');
    };
    const handlePosted = () => {
      setView('jobs');
      setPostedToast(true);
      setTimeout(() => setPostedToast(false), 2400);
    };
    let content = null;
    if (view === 'dashboard') content = /*#__PURE__*/React.createElement(window.DashboardView, {
      setView: setView
    });else if (view === 'candidates') content = /*#__PURE__*/React.createElement(window.CandidatesView, {
      credits: credits,
      unlocked: unlocked,
      onUnlock: handleUnlock
    });else if (view === 'jobs') content = /*#__PURE__*/React.createElement(window.JobsView, {
      setView: setView
    });else if (view === 'post') content = /*#__PURE__*/React.createElement(window.PostJobView, {
      onPosted: handlePosted
    });else if (view === 'earnings') content = /*#__PURE__*/React.createElement(window.EarningsView, null);
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(window.WebShell, {
      role: role,
      setRole: handleRole,
      view: view,
      setView: setView,
      credits: credits
    }, content), postedToast && /*#__PURE__*/React.createElement("div", {
      className: "cw-toast"
    }, /*#__PURE__*/React.createElement(Toast, {
      tone: "brand",
      title: "Submitted for verification",
      onClose: () => setPostedToast(false)
    }, "We'll confirm the job is real and publish within a few hours.")));
  }
  ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(CompanyWebApp, null));
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/company-web/app.jsx", error: String((e && e.message) || e) }); }

// ui_kits/company-web/screens.jsx
try { (() => {
/* BadaBhai · Company / Agency web app (Next.js product) — screens.
   Role-aware demand loop: post → browse masked → unlock → contact. */
(function () {
  const DS = window.BadaBhaiDesignSystem_01ff85;
  const {
    Button,
    IconButton,
    Input,
    Textarea,
    Select,
    Badge,
    Card,
    Tabs,
    Dialog,
    Avatar,
    StatTile,
    MaskedCandidate,
    ProgressBar,
    Toast,
    BadaBhaiLogo,
    Chip
  } = DS;
  const ACCOUNT = {
    company: {
      name: 'Kalyani Industries',
      plan: 'Company account'
    },
    agency: {
      name: 'Apex Staffing',
      plan: 'Agency · supply + demand'
    }
  };
  const CANDIDATES = [{
    id: 1,
    name: 'Ramesh Kumar',
    trade: 'CNC Operator',
    experience: '6 yrs',
    location: 'Pimpri, Pune',
    matchLabel: 'Strong match'
  }, {
    id: 2,
    name: 'Suresh Patil',
    trade: 'VMC Setter',
    experience: '4 yrs',
    location: 'Chakan, Pune'
  }, {
    id: 3,
    name: 'Imran Shaikh',
    trade: 'CNC Operator',
    experience: '8 yrs',
    location: 'Bhosari, Pune',
    matchLabel: 'Strong match'
  }, {
    id: 4,
    name: 'Vikas More',
    trade: 'Quality Inspector',
    experience: '3 yrs',
    location: 'Hadapsar, Pune'
  }, {
    id: 5,
    name: 'Ganesh Jadhav',
    trade: 'CNC Operator',
    experience: '2 yrs',
    location: 'Wagholi, Pune'
  }];
  const JOBS = [{
    title: 'CNC Operator',
    band: '5–10 vacancies',
    filled: 7,
    quota: 10,
    status: 'live',
    applicants: 23
  }, {
    title: 'VMC Setter',
    band: '1 vacancy',
    filled: 1,
    quota: 1,
    status: 'filled',
    applicants: 9
  }, {
    title: 'Quality Inspector',
    band: '2–4 vacancies',
    filled: 1,
    quota: 4,
    status: 'review',
    applicants: 0
  }];

  /* ---------- Shell ---------- */
  function WebShell({
    role,
    setRole,
    view,
    setView,
    credits,
    children
  }) {
    const nav = [{
      id: 'dashboard',
      label: 'Dashboard',
      icon: 'gauge'
    }, {
      id: 'candidates',
      label: 'Find candidates',
      icon: 'magnifying-glass'
    }, {
      id: 'jobs',
      label: 'My jobs',
      icon: 'briefcase'
    }, {
      id: 'post',
      label: 'Post a job',
      icon: 'plus-circle'
    }];
    if (role === 'agency') nav.push({
      id: 'earnings',
      label: 'Earnings',
      icon: 'wallet'
    });
    const titles = {
      dashboard: 'Dashboard',
      candidates: 'Find candidates',
      jobs: 'My jobs',
      post: 'Post a job',
      earnings: 'Agency earnings'
    };
    const acct = ACCOUNT[role];
    return /*#__PURE__*/React.createElement("div", {
      className: "cw"
    }, /*#__PURE__*/React.createElement("aside", {
      className: "cw-side",
      "data-theme": "ink"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cw-side__brand"
    }, /*#__PURE__*/React.createElement(BadaBhaiLogo, {
      theme: "ink",
      size: 26
    })), /*#__PURE__*/React.createElement("nav", {
      className: "cw-side__nav"
    }, nav.map(n => /*#__PURE__*/React.createElement("button", {
      key: n.id,
      className: `cw-navitem ${view === n.id ? 'cw-navitem--active' : ''}`,
      onClick: () => setView(n.id)
    }, /*#__PURE__*/React.createElement("i", {
      className: `${view === n.id ? 'ph-fill' : 'ph'} ph-${n.icon}`,
      "aria-hidden": "true"
    }), /*#__PURE__*/React.createElement("span", null, n.label)))), /*#__PURE__*/React.createElement("div", {
      className: "cw-acct"
    }, /*#__PURE__*/React.createElement(Avatar, {
      name: acct.name,
      size: 36,
      brand: true
    }), /*#__PURE__*/React.createElement("div", {
      className: "cw-acct__text"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cw-acct__name"
    }, acct.name), /*#__PURE__*/React.createElement("div", {
      className: "cw-acct__plan"
    }, acct.plan)))), /*#__PURE__*/React.createElement("div", {
      className: "cw-main"
    }, /*#__PURE__*/React.createElement("header", {
      className: "cw-top"
    }, /*#__PURE__*/React.createElement("h1", {
      className: "cw-top__title"
    }, titles[view]), /*#__PURE__*/React.createElement("div", {
      className: "cw-top__right"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cw-credits"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-lock-key-open",
      "aria-hidden": "true"
    }), /*#__PURE__*/React.createElement("b", null, credits), " unlocks"), /*#__PURE__*/React.createElement(Tabs, {
      variant: "segmented",
      value: role,
      onChange: setRole,
      tabs: [{
        id: 'company',
        label: 'Company'
      }, {
        id: 'agency',
        label: 'Agency'
      }]
    }), /*#__PURE__*/React.createElement(IconButton, {
      icon: "bell",
      label: "Notifications",
      variant: "outline"
    }))), /*#__PURE__*/React.createElement("main", {
      className: "cw-content"
    }, children)));
  }

  /* ---------- Dashboard ---------- */
  function DashboardView({
    setView
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: "cw-stack"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cw-stats"
    }, /*#__PURE__*/React.createElement(StatTile, {
      label: "Paid unlocks this week",
      value: "1,284",
      icon: "lock-key-open",
      delta: "+12% vs last",
      deltaDir: "up"
    }), /*#__PURE__*/React.createElement(StatTile, {
      label: "Repeat-unlock rate",
      value: "62%",
      icon: "repeat",
      delta: "health metric",
      deltaDir: "flat"
    }), /*#__PURE__*/React.createElement(StatTile, {
      label: "Active jobs",
      value: "7",
      icon: "briefcase",
      delta: "2 near quota",
      deltaDir: "up"
    }), /*#__PURE__*/React.createElement(StatTile, {
      label: "Avg reply time",
      value: "3.4h",
      icon: "chat-circle-dots",
      delta: "\u221218%",
      deltaDir: "down"
    })), /*#__PURE__*/React.createElement("div", {
      className: "cw-grid2"
    }, /*#__PURE__*/React.createElement(Card, null, /*#__PURE__*/React.createElement("div", {
      className: "cw-card__head"
    }, /*#__PURE__*/React.createElement("h3", null, "Recent activity"), /*#__PURE__*/React.createElement(Button, {
      variant: "ghost",
      size: "sm",
      onClick: () => setView('candidates')
    }, "Find candidates")), /*#__PURE__*/React.createElement("ul", {
      className: "cw-activity"
    }, /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("span", {
      className: "cw-act__icon cw-act__icon--green"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-lock-key-open"
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", null, "Unlocked"), " Ramesh K. \xB7 CNC Operator", /*#__PURE__*/React.createElement("span", {
      className: "cw-act__time"
    }, "12 min ago"))), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("span", {
      className: "cw-act__icon cw-act__icon--brand"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-hand-swipe-right"
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", null, "9 new applicants"), " on VMC Setter", /*#__PURE__*/React.createElement("span", {
      className: "cw-act__time"
    }, "1 hr ago"))), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("span", {
      className: "cw-act__icon cw-act__icon--amber"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-warning"
    })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", null, "CNC Operator"), " is 70% to quota", /*#__PURE__*/React.createElement("span", {
      className: "cw-act__time"
    }, "2 hr ago"))))), /*#__PURE__*/React.createElement(Card, {
      variant: "ink",
      className: "cw-topup"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cw-topup__h"
    }, "Top up unlocks"), /*#__PURE__*/React.createElement("p", {
      className: "cw-topup__p"
    }, "Each contact unlock is \u20B940 flat. Buy in bulk \u2014 the 1,000-pack carries a real discount."), /*#__PURE__*/React.createElement("div", {
      className: "cw-packs"
    }, /*#__PURE__*/React.createElement("button", {
      className: "cw-pack"
    }, /*#__PURE__*/React.createElement("b", null, "50"), /*#__PURE__*/React.createElement("span", null, "\u20B92,000")), /*#__PURE__*/React.createElement("button", {
      className: "cw-pack"
    }, /*#__PURE__*/React.createElement("b", null, "200"), /*#__PURE__*/React.createElement("span", null, "\u20B97,600")), /*#__PURE__*/React.createElement("button", {
      className: "cw-pack cw-pack--best"
    }, /*#__PURE__*/React.createElement("span", {
      className: "cw-pack__tag"
    }, "Best value"), /*#__PURE__*/React.createElement("b", null, "1,000"), /*#__PURE__*/React.createElement("span", null, "\u20B934,000"))))));
  }

  /* ---------- Find candidates (the demand loop) ---------- */
  function CandidatesView({
    credits,
    unlocked,
    onUnlock
  }) {
    const [pending, setPending] = React.useState(null);
    const [toast, setToast] = React.useState(false);
    const [trade, setTrade] = React.useState('cnc');
    const confirm = () => {
      onUnlock(pending.id);
      setPending(null);
      setToast(true);
      setTimeout(() => setToast(false), 1800);
    };
    return /*#__PURE__*/React.createElement("div", {
      className: "cw-stack"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cw-searchbar"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cw-searchbar__input"
    }, /*#__PURE__*/React.createElement(Input, {
      iconLeft: "magnifying-glass",
      placeholder: "Search trade, skill, or location\u2026"
    })), /*#__PURE__*/React.createElement(Select, {
      value: trade,
      onChange: e => setTrade(e.target.value)
    }, /*#__PURE__*/React.createElement("option", {
      value: "cnc"
    }, "CNC Operator"), /*#__PURE__*/React.createElement("option", {
      value: "vmc"
    }, "VMC Setter"), /*#__PURE__*/React.createElement("option", {
      value: "qc"
    }, "Quality Inspector")), /*#__PURE__*/React.createElement(Button, {
      variant: "secondary",
      iconLeft: "sliders-horizontal"
    }, "Filters")), /*#__PURE__*/React.createElement("div", {
      className: "cw-chips"
    }, /*#__PURE__*/React.createElement(Chip, {
      icon: "map-pin",
      selected: true
    }, "Pune \xB7 25 km"), /*#__PURE__*/React.createElement(Chip, {
      icon: "shield-check",
      selected: true
    }, "Verified"), /*#__PURE__*/React.createElement(Chip, {
      icon: "medal"
    }, "3+ yrs"), /*#__PURE__*/React.createElement(Chip, {
      icon: "clock"
    }, "Available now")), /*#__PURE__*/React.createElement("div", {
      className: "cw-resultmeta"
    }, /*#__PURE__*/React.createElement("b", null, CANDIDATES.length), " verified candidates \xB7 sorted by relevance, never by who paid"), /*#__PURE__*/React.createElement("div", {
      className: "cw-candlist"
    }, CANDIDATES.map(c => /*#__PURE__*/React.createElement(MaskedCandidate, {
      key: c.id,
      name: c.name,
      trade: c.trade,
      experience: c.experience,
      location: c.location,
      matchLabel: c.matchLabel,
      masked: !unlocked.has(c.id),
      onUnlock: () => setPending(c)
    }))), /*#__PURE__*/React.createElement(Dialog, {
      open: !!pending,
      onClose: () => setPending(null),
      title: "Unlock this candidate?",
      footer: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Button, {
        variant: "ghost",
        onClick: () => setPending(null)
      }, "Cancel"), /*#__PURE__*/React.createElement(Button, {
        variant: "primary",
        iconLeft: "lock-key-open",
        onClick: confirm
      }, "Unlock for \u20B940"))
    }, "You'll see their name and phone number. One unlock credit will be used (", credits, " left). Unlocking only reveals contact \u2014 it never changes a worker's ranking."), toast && /*#__PURE__*/React.createElement("div", {
      className: "cw-toast"
    }, /*#__PURE__*/React.createElement(Toast, {
      tone: "success",
      title: "Unlocked!"
    }, "Contact details are now visible. Reach out within the app.")));
  }

  /* ---------- My jobs ---------- */
  function JobsView({
    setView
  }) {
    const statusBadge = {
      live: /*#__PURE__*/React.createElement(Badge, {
        tone: "success",
        icon: "circle"
      }, "Live"),
      filled: /*#__PURE__*/React.createElement(Badge, {
        tone: "neutral",
        upper: true
      }, "Filled"),
      review: /*#__PURE__*/React.createElement(Badge, {
        tone: "warning",
        icon: "clock"
      }, "In review")
    };
    return /*#__PURE__*/React.createElement("div", {
      className: "cw-stack"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cw-rowhead"
    }, /*#__PURE__*/React.createElement("span", null, JOBS.length, " jobs"), /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      iconLeft: "plus",
      onClick: () => setView('post')
    }, "Post a job")), /*#__PURE__*/React.createElement("div", {
      className: "cw-joblist"
    }, JOBS.map((j, i) => /*#__PURE__*/React.createElement(Card, {
      key: i,
      className: "cw-jobrow"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cw-jobrow__main"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cw-jobrow__title"
    }, j.title, " ", statusBadge[j.status]), /*#__PURE__*/React.createElement("div", {
      className: "cw-jobrow__meta"
    }, j.band, " \xB7 ", j.applicants, " applicants"), /*#__PURE__*/React.createElement("div", {
      className: "cw-jobrow__bar"
    }, /*#__PURE__*/React.createElement(ProgressBar, {
      value: j.filled / j.quota * 100,
      tone: j.status === 'filled' ? 'success' : 'brand',
      label: `Applicant quota · ${j.filled}/${j.quota}`,
      showValue: true
    }))), /*#__PURE__*/React.createElement("div", {
      className: "cw-jobrow__actions"
    }, /*#__PURE__*/React.createElement(Button, {
      variant: "secondary",
      iconLeft: "users-three",
      disabled: j.applicants === 0
    }, "Applicants"), /*#__PURE__*/React.createElement(IconButton, {
      icon: "dots-three",
      label: "More",
      variant: "outline"
    }))))));
  }

  /* ---------- Post a job ---------- */
  function PostJobView({
    onPosted
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: "cw-postwrap"
    }, /*#__PURE__*/React.createElement(Card, {
      className: "cw-form"
    }, /*#__PURE__*/React.createElement(Input, {
      label: "Job title",
      placeholder: "e.g. CNC Operator",
      defaultValue: "CNC Operator"
    }), /*#__PURE__*/React.createElement("div", {
      className: "cw-form__row"
    }, /*#__PURE__*/React.createElement(Select, {
      label: "Trade family"
    }, /*#__PURE__*/React.createElement("option", null, "CNC / VMC machining"), /*#__PURE__*/React.createElement("option", null, "Welding & fabrication"), /*#__PURE__*/React.createElement("option", null, "Quality & inspection")), /*#__PURE__*/React.createElement(Select, {
      label: "Vacancy band",
      hint: "Small bands stay free"
    }, /*#__PURE__*/React.createElement("option", null, "1 vacancy"), /*#__PURE__*/React.createElement("option", null, "2\u20134 vacancies"), /*#__PURE__*/React.createElement("option", null, "5\u201310 vacancies"), /*#__PURE__*/React.createElement("option", null, "10+ vacancies"))), /*#__PURE__*/React.createElement("div", {
      className: "cw-form__row"
    }, /*#__PURE__*/React.createElement(Input, {
      label: "Location",
      iconLeft: "map-pin",
      defaultValue: "Pimpri-Chinchwad, Pune"
    }), /*#__PURE__*/React.createElement(Input, {
      label: "Monthly salary",
      iconLeft: "currency-inr",
      defaultValue: "22,000 \u2013 28,000"
    })), /*#__PURE__*/React.createElement(Textarea, {
      label: "What will they do?",
      rows: 4,
      defaultValue: "Operate Fanuc CNC, load programs, run quality checks, maintain output."
    }), /*#__PURE__*/React.createElement("div", {
      className: "cw-verify"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-shield-check"
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", null, "Verification-gated."), " We confirm this job is real before workers see it \u2014 ghost jobs waste swipes and erode trust. Posting is free through launch.")), /*#__PURE__*/React.createElement("div", {
      className: "cw-form__foot"
    }, /*#__PURE__*/React.createElement(Button, {
      variant: "ghost"
    }, "Save draft"), /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      iconLeft: "paper-plane-right",
      onClick: onPosted
    }, "Submit for verification"))));
  }

  /* ---------- Agency earnings (parked / fast-follow) ---------- */
  function EarningsView() {
    return /*#__PURE__*/React.createElement("div", {
      className: "cw-empty"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cw-empty__icon"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-wallet"
    })), /*#__PURE__*/React.createElement("h2", null, "Supply dashboard is coming soon"), /*#__PURE__*/React.createElement("p", null, "Referral links, payouts, KYC and the 25% rev-share engine are the first fast-follow after alpha. For now, the Agency uses the same demand loop as a Company \u2014 post jobs and unlock candidates."), /*#__PURE__*/React.createElement(Badge, {
      tone: "warning",
      upper: true
    }, "Fast-follow \xB7 post-alpha"));
  }
  Object.assign(window, {
    WebShell,
    DashboardView,
    CandidatesView,
    JobsView,
    PostJobView,
    EarningsView
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/company-web/screens.jsx", error: String((e && e.message) || e) }); }

// ui_kits/worker-app/app.jsx
try { (() => {
(function () {
  const {
    BottomNav
  } = window.BadaBhaiDesignSystem_01ff85;

  /* Worker app flow: login → chat onboarding → resume → tabbed app (jobs/resume/profile). */
  function WorkerApp() {
    const [phase, setPhase] = React.useState('login');
    const [tab, setTab] = React.useState('jobs');
    if (phase === 'login') {
      return /*#__PURE__*/React.createElement(window.LoginScreen, {
        onDone: () => setPhase('chat')
      });
    }
    if (phase === 'chat') {
      return /*#__PURE__*/React.createElement(window.DeviceFrame, null, /*#__PURE__*/React.createElement(window.ChatScreen, {
        onResume: () => setPhase('resume')
      }));
    }
    if (phase === 'resume') {
      return /*#__PURE__*/React.createElement(window.DeviceFrame, null, /*#__PURE__*/React.createElement(window.ResumeScreen, {
        onExplore: () => {
          setTab('jobs');
          setPhase('app');
        }
      }));
    }
    const body = {
      jobs: /*#__PURE__*/React.createElement(window.FeedScreen, null),
      resume: /*#__PURE__*/React.createElement(window.ResumeScreen, null),
      profile: /*#__PURE__*/React.createElement(window.ProfileScreen, null)
    }[tab];
    return /*#__PURE__*/React.createElement(window.DeviceFrame, null, /*#__PURE__*/React.createElement("div", {
      className: "wa-app"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-app__body"
    }, body), /*#__PURE__*/React.createElement(BottomNav, {
      value: tab,
      onChange: setTab,
      items: [{
        id: 'jobs',
        label: 'Jobs',
        icon: 'briefcase'
      }, {
        id: 'resume',
        label: 'Resume',
        icon: 'file-text'
      }, {
        id: 'profile',
        label: 'Profile',
        icon: 'user'
      }]
    })));
  }
  ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(WorkerApp, null));
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/worker-app/app.jsx", error: String((e && e.message) || e) }); }

// ui_kits/worker-app/screens.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* BadaBhai · Worker mobile app (Flutter product) — screens.
   Composes the design-system primitives from the compiled bundle. */
(function () {
  const DS = window.BadaBhaiDesignSystem_01ff85;
  const {
    Button,
    IconButton,
    Input,
    OtpInput,
    Chip,
    Badge,
    Avatar,
    Card,
    ChatBubble,
    JobCard,
    BottomNav,
    ProgressBar,
    Switch,
    Toast,
    BadaBhaiLogo
  } = DS;

  /* ---------- Device frame ---------- */
  function StatusBar({
    dark
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: `wa-status ${dark ? 'wa-status--dark' : ''}`
    }, /*#__PURE__*/React.createElement("span", {
      className: "wa-status__time"
    }, "9:41"), /*#__PURE__*/React.createElement("span", {
      className: "wa-status__icons"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-cell-signal-full"
    }), /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-wifi-high"
    }), /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-battery-high"
    })));
  }
  function DeviceFrame({
    children,
    statusDark
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: "wa-device"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-device__screen"
    }, /*#__PURE__*/React.createElement(StatusBar, {
      dark: statusDark
    }), children));
  }

  /* ---------- Login (phone → OTP) ---------- */
  function LoginScreen({
    onDone
  }) {
    const [step, setStep] = React.useState('phone');
    const [phone, setPhone] = React.useState('98765 43210');
    const [code, setCode] = React.useState('');
    const [lang, setLang] = React.useState('hi');
    return /*#__PURE__*/React.createElement(DeviceFrame, null, /*#__PURE__*/React.createElement("div", {
      className: "wa-screen wa-login"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-login__brand"
    }, /*#__PURE__*/React.createElement(BadaBhaiLogo, {
      variant: "mark",
      size: 68
    }), /*#__PURE__*/React.createElement("h1", {
      className: "wa-login__title"
    }, "Aapka kaam,", /*#__PURE__*/React.createElement("br", null), "bada bhai ke saath."), /*#__PURE__*/React.createElement("p", {
      className: "wa-login__sub"
    }, "No test. Just talk. Apna profile chat se banayein.")), step === 'phone' ? /*#__PURE__*/React.createElement("div", {
      className: "wa-login__form"
    }, /*#__PURE__*/React.createElement(Input, {
      label: "Phone number",
      iconLeft: "phone",
      inputMode: "tel",
      value: phone,
      onChange: e => setPhone(e.target.value)
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "wa-login__lang-label"
    }, "Aap kis bhasha mein baat karein?"), /*#__PURE__*/React.createElement("div", {
      className: "wa-chips"
    }, /*#__PURE__*/React.createElement(Chip, {
      selected: lang === 'hi',
      onClick: () => setLang('hi')
    }, "\u0939\u093F\u0902\u0926\u0940"), /*#__PURE__*/React.createElement(Chip, {
      selected: lang === 'mr',
      onClick: () => setLang('mr')
    }, "\u092E\u0930\u093E\u0920\u0940"), /*#__PURE__*/React.createElement(Chip, {
      selected: lang === 'en',
      onClick: () => setLang('en')
    }, "English"))), /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      size: "lg",
      block: true,
      iconRight: "arrow-right",
      onClick: () => setStep('otp')
    }, "Continue"), /*#__PURE__*/React.createElement("p", {
      className: "wa-login__legal"
    }, "By continuing you agree to our terms & data-use consent, including model training.")) : /*#__PURE__*/React.createElement("div", {
      className: "wa-login__form"
    }, /*#__PURE__*/React.createElement("button", {
      className: "wa-back",
      onClick: () => setStep('phone')
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-arrow-left"
    }), " Back"), /*#__PURE__*/React.createElement("div", {
      className: "wa-otp-copy"
    }, "Enter the 4-digit code we sent to ", /*#__PURE__*/React.createElement("b", null, "+91 ", phone)), /*#__PURE__*/React.createElement(OtpInput, {
      length: 4,
      value: code,
      onChange: setCode,
      autoFocus: true
    }), /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      size: "lg",
      block: true,
      onClick: onDone,
      disabled: code.length < 4
    }, "Verify & start"), /*#__PURE__*/React.createElement("button", {
      className: "wa-link"
    }, "Resend code in 0:24"))));
  }

  /* ---------- Chat onboarding (the front door) ---------- */
  const CHAT_SCRIPT = [{
    from: 'bot',
    text: 'Namaste! 🙏 Main aapka bada bhai. 2 minute baat karein, phir aapka profile aur resume taiyaar.'
  }, {
    from: 'bot',
    text: 'Aap kaun si machine pe kaam karte hain?'
  }, {
    from: 'user',
    text: 'CNC operator. Fanuc control.'
  }, {
    from: 'bot',
    text: 'Badhiya! Kitne saal ka experience hai?'
  }, {
    from: 'user',
    voice: true,
    duration: '0:14'
  }, {
    from: 'bot',
    text: 'Samajh gaya — 6 saal. Pune ke aas-paas kaam dhoond rahe hain?'
  }, {
    from: 'user',
    text: 'Haan, Pimpri-Chinchwad.'
  }, {
    from: 'bot',
    text: 'Perfect. Aapka resume ready hai 👍'
  }];
  function ChatScreen({
    onResume
  }) {
    const [shown, setShown] = React.useState(5);
    const done = shown >= CHAT_SCRIPT.length;
    return /*#__PURE__*/React.createElement("div", {
      className: "wa-screen wa-chat"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-appbar"
    }, /*#__PURE__*/React.createElement(BadaBhaiLogo, {
      variant: "mark",
      size: 34
    }), /*#__PURE__*/React.createElement("div", {
      className: "wa-appbar__title"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-appbar__name"
    }, "Bada Bhai"), /*#__PURE__*/React.createElement("div", {
      className: "wa-appbar__status"
    }, /*#__PURE__*/React.createElement("span", {
      className: "wa-dot"
    }), " online")), /*#__PURE__*/React.createElement(IconButton, {
      icon: "dots-three-vertical",
      label: "More"
    })), /*#__PURE__*/React.createElement("div", {
      className: "wa-chat__thread"
    }, CHAT_SCRIPT.slice(0, shown).map((m, i) => /*#__PURE__*/React.createElement(ChatBubble, {
      key: i,
      from: m.from,
      voice: m.voice,
      duration: m.duration,
      time: i % 2 ? '9:0' + (i + 1) : undefined
    }, m.text)), done && /*#__PURE__*/React.createElement("div", {
      className: "wa-chat__cta"
    }, /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      size: "lg",
      block: true,
      iconRight: "file-text",
      onClick: onResume
    }, "See my resume"))), /*#__PURE__*/React.createElement("div", {
      className: "wa-composer"
    }, /*#__PURE__*/React.createElement(IconButton, {
      icon: "microphone",
      label: "Voice note",
      variant: "solid",
      size: "lg"
    }), /*#__PURE__*/React.createElement("div", {
      className: "wa-composer__input"
    }, "Type or hold mic to talk\u2026"), !done ? /*#__PURE__*/React.createElement(IconButton, {
      icon: "paper-plane-right",
      label: "Send",
      variant: "solid",
      size: "lg",
      onClick: () => setShown(s => Math.min(s + 1, CHAT_SCRIPT.length))
    }) : /*#__PURE__*/React.createElement(IconButton, {
      icon: "paper-plane-right",
      label: "Send",
      size: "lg"
    })));
  }

  /* ---------- Resume ready ---------- */
  function ResumeScreen({
    onExplore
  }) {
    return /*#__PURE__*/React.createElement("div", {
      className: "wa-screen wa-resume"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__hero"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-stamp"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-bold ph-check"
    })), /*#__PURE__*/React.createElement("h2", null, "Resume ready!"), /*#__PURE__*/React.createElement("p", null, "Ek branded, share-ready resume \u2014 bilkul free.")), /*#__PURE__*/React.createElement(Card, {
      className: "wa-resume__doc",
      padding: "none"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__docTop"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__name"
    }, "Ramesh Kumar"), /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__role"
    }, "CNC Operator \xB7 6 years")), /*#__PURE__*/React.createElement(BadaBhaiLogo, {
      variant: "mark",
      size: 30
    })), /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__section"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__h"
    }, "Skills"), /*#__PURE__*/React.createElement("div", {
      className: "wa-chips"
    }, /*#__PURE__*/React.createElement("span", {
      className: "bb-badge bb-badge--neutral"
    }, "Fanuc control"), /*#__PURE__*/React.createElement("span", {
      className: "bb-badge bb-badge--neutral"
    }, "VMC setting"), /*#__PURE__*/React.createElement("span", {
      className: "bb-badge bb-badge--neutral"
    }, "GD&T reading"), /*#__PURE__*/React.createElement("span", {
      className: "bb-badge bb-badge--neutral"
    }, "Quality check"))), /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__section"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__h"
    }, "Experience"), /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__exp"
    }, /*#__PURE__*/React.createElement("b", null, "Operator"), " \xB7 Kalyani Industries \xB7 2020\u2013now"), /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__exp"
    }, /*#__PURE__*/React.createElement("b", null, "Trainee"), " \xB7 MIDC Bhosari \xB7 2018\u20132020")), /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__watermark"
    }, "Made with BadaBhai")), /*#__PURE__*/React.createElement("div", {
      className: "wa-resume__actions"
    }, /*#__PURE__*/React.createElement(Button, {
      variant: "primary",
      size: "lg",
      block: true,
      iconLeft: "download-simple"
    }, "Download PDF"), /*#__PURE__*/React.createElement(Button, {
      variant: "success",
      size: "lg",
      block: true,
      iconLeft: "whatsapp-logo"
    }, "Share on WhatsApp")), /*#__PURE__*/React.createElement("p", {
      className: "wa-resume__note"
    }, "Naam, photo aur phone aap control karte hain \u2014 Profile mein badlein."), onExplore && /*#__PURE__*/React.createElement(Button, {
      variant: "secondary",
      size: "lg",
      block: true,
      iconRight: "arrow-right",
      className: "wa-resume__explore",
      onClick: onExplore
    }, "Explore jobs near me"));
  }

  /* ---------- Job feed (swipe-to-apply) ---------- */
  const JOBS = [{
    title: 'CNC Operator',
    company: 'Sharma Precision Works',
    location: 'Pimpri, Pune',
    shift: 'Day shift',
    salary: '₹22,000–28,000 / mo',
    tags: ['Fanuc control', '2+ yrs', 'PF + ESI'],
    vacanciesLeft: 4
  }, {
    title: 'VMC Setter',
    company: 'Deccan Auto Components',
    location: 'Chakan, Pune',
    shift: 'Rotational',
    salary: '₹26,000–32,000 / mo',
    tags: ['VMC', 'Setting', '4+ yrs'],
    vacanciesLeft: 2
  }, {
    title: 'Quality Inspector',
    company: 'Bharat Forge Vendor',
    location: 'Bhosari, Pune',
    shift: 'General',
    salary: '₹20,000–24,000 / mo',
    tags: ['GD&T', 'CMM', '1+ yr'],
    vacanciesLeft: 6
  }];
  function FeedScreen() {
    const [idx, setIdx] = React.useState(0);
    const [applied, setApplied] = React.useState(0);
    const [toast, setToast] = React.useState(null);
    const job = JOBS[idx % JOBS.length];
    const next = didApply => {
      if (didApply) {
        setApplied(a => a + 1);
        setToast('applied');
      } else setToast('skipped');
      setTimeout(() => setToast(null), 1600);
      setIdx(i => i + 1);
    };
    return /*#__PURE__*/React.createElement("div", {
      className: "wa-screen wa-feed"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-appbar wa-appbar--feed"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "wa-feed__eyebrow"
    }, "Jobs near you"), /*#__PURE__*/React.createElement("div", {
      className: "wa-feed__loc"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-map-pin"
    }), " Pune \xB7 15 km")), /*#__PURE__*/React.createElement(IconButton, {
      icon: "sliders-horizontal",
      label: "Filters",
      variant: "outline"
    })), /*#__PURE__*/React.createElement("div", {
      className: "wa-chips wa-feed__filters"
    }, /*#__PURE__*/React.createElement(Chip, {
      icon: "wrench",
      selected: true
    }, "CNC"), /*#__PURE__*/React.createElement(Chip, {
      icon: "wrench"
    }, "VMC"), /*#__PURE__*/React.createElement(Chip, {
      icon: "shield-check"
    }, "Verified"), /*#__PURE__*/React.createElement(Chip, {
      icon: "clock"
    }, "Day shift")), /*#__PURE__*/React.createElement("div", {
      className: "wa-feed__deck"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-feed__behind wa-feed__behind2"
    }), /*#__PURE__*/React.createElement("div", {
      className: "wa-feed__behind wa-feed__behind1"
    }), /*#__PURE__*/React.createElement(JobCard, _extends({
      key: idx
    }, job, {
      onApply: () => next(true),
      onSkip: () => next(false)
    }))), /*#__PURE__*/React.createElement("div", {
      className: "wa-feed__hint"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph ph-hand-swipe-left"
    }), " Skip \xB7 Apply ", /*#__PURE__*/React.createElement("i", {
      className: "ph ph-hand-swipe-right"
    })), toast && /*#__PURE__*/React.createElement("div", {
      className: "wa-toast-host"
    }, /*#__PURE__*/React.createElement(Toast, {
      tone: toast === 'applied' ? 'success' : 'neutral',
      title: toast === 'applied' ? 'Applied!' : 'Skipped'
    }, toast === 'applied' ? 'Employer ko bata diya. ' + applied + ' applied today.' : 'Agla job dikha rahe hain.')));
  }

  /* ---------- Profile ---------- */
  function ProfileScreen() {
    return /*#__PURE__*/React.createElement("div", {
      className: "wa-screen wa-profile"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-appbar"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-appbar__name wa-appbar__name--lg"
    }, "Profile")), /*#__PURE__*/React.createElement("div", {
      className: "wa-profile__head"
    }, /*#__PURE__*/React.createElement(Avatar, {
      name: "Ramesh Kumar",
      size: 72,
      brand: true,
      verified: true
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "wa-profile__name"
    }, "Ramesh Kumar"), /*#__PURE__*/React.createElement("div", {
      className: "wa-profile__role"
    }, "CNC Operator \xB7 Pune"), /*#__PURE__*/React.createElement("span", {
      className: "bb-badge bb-badge--success",
      style: {
        marginTop: 6
      }
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-seal-check"
    }), " Verified"))), /*#__PURE__*/React.createElement(Card, {
      className: "wa-card"
    }, /*#__PURE__*/React.createElement(ProgressBar, {
      value: 72,
      label: "Profile strength",
      showValue: true
    }), /*#__PURE__*/React.createElement("p", {
      className: "wa-muted",
      style: {
        marginTop: 10
      }
    }, "Add a photo to reach 100% and get seen more.")), /*#__PURE__*/React.createElement(Card, {
      className: "wa-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-card__h"
    }, "What employers can see"), /*#__PURE__*/React.createElement("div", {
      className: "wa-toggles"
    }, /*#__PURE__*/React.createElement(Switch, {
      defaultChecked: true,
      label: "Show my phone to verified employers"
    }), /*#__PURE__*/React.createElement(Switch, {
      defaultChecked: true,
      label: "Show my photo"
    }), /*#__PURE__*/React.createElement(Switch, {
      label: "Open to night shift"
    }))), /*#__PURE__*/React.createElement(Card, {
      className: "wa-card wa-kit",
      interactive: true
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-kit__icon"
    }, /*#__PURE__*/React.createElement("i", {
      className: "ph-fill ph-exam"
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "wa-card__h"
    }, "CNC interview kit"), /*#__PURE__*/React.createElement("div", {
      className: "wa-muted"
    }, "15 common questions + answers")), /*#__PURE__*/React.createElement("i", {
      className: "ph ph-download-simple wa-kit__dl"
    })));
  }
  Object.assign(window, {
    DeviceFrame,
    LoginScreen,
    ChatScreen,
    ResumeScreen,
    FeedScreen,
    ProfileScreen
  });
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/worker-app/screens.jsx", error: String((e && e.message) || e) }); }

__ds_ns.BadaBhaiLogo = __ds_scope.BadaBhaiLogo;

__ds_ns.ChatBubble = __ds_scope.ChatBubble;

__ds_ns.JobCard = __ds_scope.JobCard;

__ds_ns.MaskedCandidate = __ds_scope.MaskedCandidate;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Chip = __ds_scope.Chip;

__ds_ns.StatTile = __ds_scope.StatTile;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.ProgressBar = __ds_scope.ProgressBar;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Tooltip = __ds_scope.Tooltip;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Checkbox = __ds_scope.Checkbox;

__ds_ns.IconButton = __ds_scope.IconButton;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.OtpInput = __ds_scope.OtpInput;

__ds_ns.Radio = __ds_scope.Radio;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Textarea = __ds_scope.Textarea;

__ds_ns.BottomNav = __ds_scope.BottomNav;

__ds_ns.Tabs = __ds_scope.Tabs;

})();
