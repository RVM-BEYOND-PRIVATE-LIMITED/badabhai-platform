Circular avatar with initials fallback. Carries the two product-critical states.

```jsx
<Avatar name="Ramesh Kumar" size={56} verified />
<Avatar name="Ramesh Kumar" masked />   {/* blurred until unlocked */}
```

- `masked` blurs the image/initials (pre-unlock candidate).
- `verified` adds the green seal overlay.
