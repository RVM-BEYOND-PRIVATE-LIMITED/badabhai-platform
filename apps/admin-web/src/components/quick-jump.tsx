"use client";

import { useCallback, useEffect, useId, useReducer, useRef, useSyncExternalStore } from "react";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { SubmitPendingCue, usePendingPush } from "./nav-pending";
import {
  INITIAL_JUMP_STATE,
  jumpHint,
  jumpOptions,
  jumpReducer,
  parseJumpQuery,
  type JumpKindId,
  type JumpOption,
} from "./quick-jump-model";

/** Ctrl/⌘K — the shortcut that opens the palette (and closes it again). */
export function isJumpShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}): boolean {
  return (
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    !e.shiftKey &&
    !e.isComposing &&
    e.key.toLowerCase() === "k"
  );
}

const noSubscription = () => () => {};
/** The shortcut as this reader's keyboard writes it — "Ctrl K" until the browser says Mac. */
function useShortcutLabel(): string {
  return useSyncExternalStore(
    noSubscription,
    () => (/mac|iphone|ipad/i.test(navigator.platform) ? "⌘K" : "Ctrl K"),
    () => "Ctrl K",
  );
}

/**
 * THE QUICK JUMP (A6, #2576): a topbar button and Ctrl/⌘K open a small command palette that
 * jumps to a candidate, a customer or a posting by its id (`quick-jump-model.ts` says why by id
 * only). It is ONE component on purpose — the palette, not a dialog system.
 *
 *  - The native `<dialog>`, opened with `showModal()`: focus moves into it and stays there, the
 *    page behind is inert, Escape closes it, and closing puts focus back where it was.
 *  - The field is a combobox over a listbox: ↑/↓ (Home/End) move the highlight — instantly, the
 *    results never animate — and Enter opens it; a click opens an option too.
 *  - Opening fades the panel in with an 8px drop over 160ms (`.jump`, zero under reduced motion).
 *  - The navigation runs in a transition, so the button's pending dot and the shell's bar say a
 *    slow record is on its way — no loading boundary.
 *  - Behind the open mobile drawer the topbar is `inert`; the shortcut does nothing there.
 */
export function QuickJump({ kinds }: { kinds: readonly JumpKindId[] }) {
  const [state, dispatch] = useReducer(jumpReducer, INITIAL_JUMP_STATE);
  const [pending, push] = usePendingPush();
  const shortcut = useShortcutLabel();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Where focus was before the palette opened — where closing puts it back. */
  const returnFocus = useRef<Element | null>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-hint`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  const query = parseJumpQuery(state.query);
  const options = jumpOptions(query, kinds);
  const highlighted: JumpOption | undefined = options[state.highlight];
  /** The record the last pick opened — what the pending cue names while it loads. */
  const opening = useRef<JumpOption | null>(null);

  const open = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    // Behind the open drawer the whole topbar is inert — a palette opened there could not be used.
    if (triggerRef.current?.closest("[inert]")) return;
    returnFocus.current = document.activeElement;
    dispatch({ type: "reset" });
    dialog.showModal();
  }, []);

  const close = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  // Ctrl/⌘K anywhere opens it, and again closes it. `preventDefault` keeps the browser's own
  // Ctrl+K (focus the search bar) from firing over the portal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isJumpShortcut(e)) return;
      e.preventDefault();
      if (dialogRef.current?.open) close();
      else open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  function go(option: JumpOption) {
    opening.current = option;
    returnFocus.current = null; // the next page takes focus; nothing to put it back on
    close();
    push(option.href);
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="btn btn--ghost topbar__jump"
        // The visible words are "Jump to" (hidden on a phone, where the glyph stands alone).
        aria-label="Jump to a record"
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        onClick={open}
      >
        <Icon name={ACTION_ICON.search} />
        <span className="topbar__jump-label">Jump to</span>
        <kbd className="topbar__kbd" aria-hidden="true">
          {shortcut}
        </kbd>
        <SubmitPendingCue
          pending={pending}
          message={`Opening the ${opening.current ? opening.current.label.toLowerCase() : "record"}…`}
        />
      </button>

      <dialog
        ref={dialogRef}
        className="jump"
        aria-labelledby={titleId}
        onClose={() => {
          dispatch({ type: "reset" });
          const back = returnFocus.current as HTMLElement | null;
          returnFocus.current = null;
          if (back?.isConnected && typeof back.focus === "function") back.focus();
        }}
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself (its content fills it).
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="jump__panel">
          <h2 className="sr-only" id={titleId}>
            Jump to a record
          </h2>
          <div className="jump__field">
            <Icon name={ACTION_ICON.search} className="jump__icon" />
            <input
              className="jump__input"
              type="text"
              role="combobox"
              aria-label="Record id"
              aria-autocomplete="list"
              aria-expanded={options.length > 0}
              aria-controls={listId}
              aria-activedescendant={highlighted ? optionId(state.highlight) : undefined}
              aria-describedby={hintId}
              placeholder="e.g. a candidate, customer or posting id"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={state.query}
              onChange={(e) => dispatch({ type: "input", query: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (highlighted) go(highlighted);
                  return;
                }
                if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) && options.length > 0) {
                  e.preventDefault();
                  dispatch({ type: "key", key: e.key, count: options.length });
                }
              }}
            />
            <kbd className="topbar__kbd" aria-hidden="true">
              Esc
            </kbd>
          </div>
          <ul className="jump__list" id={listId} role="listbox" aria-label="Records">
            {options.map((option, i) => (
              <li
                key={option.kind}
                id={optionId(i)}
                role="option"
                aria-selected={i === state.highlight}
                className="jump__option"
                onMouseMove={() => dispatch({ type: "point", index: i })}
                onClick={() => go(option)}
              >
                <Icon name={option.icon} className="jump__option-icon" />
                <span className="jump__option-label">{option.label}</span>
                <span className="jump__option-id mono">{option.shortId}</span>
              </li>
            ))}
          </ul>
          <p className="jump__hint" id={hintId} aria-live="polite">
            {jumpHint(query, options.length)}
          </p>
        </div>
      </dialog>
    </>
  );
}
