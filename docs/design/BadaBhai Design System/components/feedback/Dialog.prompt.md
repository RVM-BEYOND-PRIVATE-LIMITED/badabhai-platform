Modal dialog or mobile bottom sheet. The card pops in with the brand spring.

```jsx
<Dialog
  open={open}
  onClose={() => setOpen(false)}
  title="Unlock this candidate?"
  footer={<>
    <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    <Button variant="primary" iconLeft="lock-key-open">Unlock for ₹40</Button>
  </>}
>
  You'll see Ramesh's name and phone number. One credit will be used.
</Dialog>
```

- `sheet` switches to a slide-up bottom sheet — use on the worker app.
