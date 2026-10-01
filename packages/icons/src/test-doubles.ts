/**
 * Test doubles for the tooltip's DOM contract — the node test env has no DOM, and the behaviour
 * under test only needs a document that is an EventTarget and a control with attributes.
 * Imported by tests only (never by the package entry points).
 */
import { TOOLTIP_DISMISSED_ATTRIBUTE } from "./control";

/** A document stand-in that counts its live keydown listeners. */
export class FakeDocument extends EventTarget {
  private readonly live = new Set<EventListenerOrEventListenerObject>();

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "keydown" && listener) this.live.add(listener);
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (type === "keydown" && listener) this.live.delete(listener);
    super.removeEventListener(type, listener, options);
  }

  /** Live keydown listeners — a leak shows up here. */
  get keydownListeners(): number {
    return this.live.size;
  }

  /** Dispatch a keydown carrying `key` (Node has no KeyboardEvent). Returns the event. */
  pressKey(key: string): Event {
    const event = new Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value: key });
    this.dispatchEvent(event);
    return event;
  }
}

/** A control stand-in: attributes, connection state and its owner document. */
export function fakeControl(doc: FakeDocument) {
  const attrs = new Map<string, string>();
  return {
    attrs,
    isConnected: true,
    ownerDocument: doc,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    get dismissed(): boolean {
      return attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE);
    },
  };
}
