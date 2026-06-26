The chat-first product's message bubble. Bot (bada bhai) sits left; the worker right.

```jsx
<ChatBubble from="bot" time="9:01">Namaste! Main aapka bada bhai. Aap CNC pe kaam karte hain?</ChatBubble>
<ChatBubble from="user" time="9:01">Haan, 6 saal se.</ChatBubble>
<ChatBubble from="user" voice duration="0:18" />   {/* async voice note */}
```

- Bot bubbles carry the inlined mark as the avatar; `voice` swaps text for a waveform.
