The payer-side candidate row — masked until unlocked. The core privacy/monetization motif.

```jsx
<MaskedCandidate trade="CNC Operator" experience="6 yrs" location="Pune" matchLabel="Strong match" masked onUnlock={unlock} />
<MaskedCandidate name="Ramesh Kumar" trade="CNC Operator" experience="6 yrs" location="Pune" masked={false} />
```

- Masked: blurred name + avatar, marigold “₹40” unlock. Unlocked: name shown, green “Unlocked”.
- Money never tilts visibility — unlocking only reveals contact, never reorders the list.
