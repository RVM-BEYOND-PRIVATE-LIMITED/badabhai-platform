import { Icon } from "@badabhai/icons";
import { Button } from "./ds";

/**
 * W4 (#2584) — the line a posting form shows when it opened with changes kept on this device
 * (components/use-posting-draft.ts): the payer can see the form is not the saved copy, and drop
 * those changes. `onDiscard` clears the stored draft and reseeds the form.
 */
export function DraftRestoredNotice({ onDiscard }: { onDiscard: () => void }) {
  return (
    <p className="mw-draft-restored" role="status">
      <Icon name="clock-counter-clockwise" />
      <span>Restored unsaved changes from this device</span>
      <span aria-hidden="true">·</span>
      <Button variant="ghost" size="sm" onClick={onDiscard}>
        Discard
      </Button>
    </p>
  );
}
