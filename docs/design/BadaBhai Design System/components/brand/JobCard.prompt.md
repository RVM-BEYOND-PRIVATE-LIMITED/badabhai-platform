The hero of the worker app — the swipe-to-apply job card. Right = apply, left = skip.

```jsx
<JobCard
  title="CNC Operator"
  company="Sharma Precision Works"
  verified
  location="Pimpri, Pune"
  shift="Day shift"
  salary="₹22,000–28,000 / mo"
  tags={['Fanuc', 'Day shift', '2+ yrs']}
  vacanciesLeft={4}
  onApply={apply}
  onSkip={skip}
/>
```

- Salary renders in Roboto Mono; the verified seal is green.
- `vacanciesLeft` ties to the purchased applicant quota; paused/filled jobs leave the feed.
