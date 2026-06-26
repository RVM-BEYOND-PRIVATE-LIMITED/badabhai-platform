The worker app's bottom navigation. Active tab is marigold with a filled icon.

```jsx
const items = [
  { id: 'chat', label: 'Chat', icon: 'chat-circle-dots' },
  { id: 'jobs', label: 'Jobs', icon: 'briefcase', badge: 3 },
  { id: 'resume', label: 'Resume', icon: 'file-text' },
  { id: 'profile', label: 'Profile', icon: 'user' },
];
<BottomNav items={items} value={tab} onChange={setTab} />
```
