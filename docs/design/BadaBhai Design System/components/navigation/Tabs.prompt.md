Tab bar. Underline for page sections; segmented for short filters / role views.

```jsx
const tabs = [
  { id: 'jobs', label: 'Jobs', icon: 'briefcase' },
  { id: 'unlocked', label: 'Unlocked', icon: 'lock-key-open' },
];
<Tabs tabs={tabs} value={tab} onChange={setTab} variant="underline" />
```
