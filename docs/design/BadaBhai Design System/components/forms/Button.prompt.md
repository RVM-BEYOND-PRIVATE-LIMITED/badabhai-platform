Primary action button — use marigold `primary` for the single most important action on a screen; quieten everything else with `secondary`, `tonal`, or `ghost`.

```jsx
<Button variant="primary" size="lg" iconLeft="lock-key-open" block>
  Unlock for ₹40
</Button>
<Button variant="secondary">Skip</Button>
<Button variant="tonal" iconLeft="download-simple">Resume</Button>
```

- `variant`: `primary` (marigold CTA) · `secondary` (outlined) · `tonal` (soft marigold) · `ghost` · `success` · `danger`
- `size`: `sm` 36 · `md` 44 · `lg` 52 (worker-app primary CTA is `lg`, full-`block`)
- `iconLeft` / `iconRight` take a Phosphor glyph name (no `ph-` prefix)
- `loading` shows a spinner and disables; press scales to 0.97
