Labelled text input with hint/error and optional Phosphor icons. 52px tall for easy tapping.

```jsx
<Input label="Phone number" iconLeft="phone" inputMode="tel" placeholder="98xxx xxxxx" />
<Input label="Full name" error="Please enter your name" />
```

- Focus ring is always marigold; error state is red with a `warning-circle`.
- Pair `iconLeft="magnifying-glass"` for search fields.
