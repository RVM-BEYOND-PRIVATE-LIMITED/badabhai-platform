Controlled one-time-passcode entry. Phone + OTP is the worker login.

```jsx
const [code, setCode] = React.useState('');
<OtpInput length={4} value={code} onChange={setCode} autoFocus />
```

- Auto-advances on digit entry; Backspace on an empty cell steps back.
- Digits render in Roboto Mono; filled cells get a marigold tint.
