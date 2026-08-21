Square, icon-only button for toolbars and dense controls. `label` is required (a11y + tooltip).

```jsx
<IconButton icon="microphone" label="Record voice note" variant="solid" size="lg" />
<IconButton icon="dots-three" label="More" />
```

- `variant`: `ghost` (default) · `solid` (marigold) · `outline`
- In the worker app, reserve icon-only for secondary affordances — primary actions always carry a text label.
