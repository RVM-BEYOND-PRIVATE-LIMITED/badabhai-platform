"use client";

import { useRef, useState } from "react";
import { Icon } from "@badabhai/icons";
import { draftDescriptionAction } from "./voice-description-action";

/**
 * The mic toggle beside the job Description field (#2720).
 *
 * Records a Hinglish note with the BROWSER's speech recogniser, then calls the
 * server action that drafts the English description. The draft lands in the
 * poster's EDITABLE textarea; `description: null` leaves the typed text
 * untouched and shows a small retry state. Nothing is published here.
 */

/** The subset of the Web Speech API this control uses (lib.dom types are partial). */
interface RecognitionAlternativeLike {
  transcript: string;
}
interface RecognitionResultLike {
  readonly length: number;
  readonly [index: number]: RecognitionAlternativeLike;
}
interface RecognitionEventLike {
  readonly results: {
    readonly length: number;
    readonly [index: number]: RecognitionResultLike;
  };
}
interface RecognitionErrorLike {
  readonly error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type Status = "idle" | "listening" | "drafting" | "failed";

export interface VoiceDescriptionButtonProps {
  /** Put a non-null draft into the editable Description box. */
  onDraft: (description: string) => void;
  /** Step 1's trade label (the 16-trade role label), when picked. */
  tradeLabel?: string;
  /** Step 1's role/job title, when typed. */
  roleLabel?: string;
  disabled?: boolean;
}

export function VoiceDescriptionButton({
  onDraft,
  tradeLabel,
  roleLabel,
  disabled = false,
}: VoiceDescriptionButtonProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const heard = useRef("");
  const statusRef = useRef<Status>("idle");

  function move(next: Status): void {
    statusRef.current = next;
    setStatus(next);
  }

  async function draft(spokenText: string): Promise<void> {
    move("drafting");
    setMessage("");
    const result = await draftDescriptionAction({
      spokenText,
      ...(tradeLabel ? { tradeLabel } : {}),
      ...(roleLabel ? { roleLabel } : {}),
    });
    if (!result.ok) {
      move("failed");
      setMessage(result.error);
      return;
    }
    const description = result.description?.trim();
    if (!description) {
      // A null draft is a VALID answer: keep the poster's own text.
      move("failed");
      setMessage("No draft this time. Your text is unchanged — retry or keep it.");
      return;
    }
    onDraft(description);
    move("idle");
    setMessage("Draft added. Review it before publishing.");
  }

  function stopAndDraft(): void {
    const rec = recognition.current;
    recognition.current = null;
    move("drafting");
    try {
      rec?.stop();
    } catch {
      // Best effort — the transcript already heard is what matters.
    }
    const spokenText = heard.current.trim();
    if (spokenText === "") {
      move("failed");
      setMessage("Didn't catch that. Tap and speak again.");
      return;
    }
    void draft(spokenText);
  }

  function start(): void {
    const Ctor = recognitionCtor();
    if (Ctor === null) {
      move("failed");
      setMessage("Voice input isn't available in this browser. Type the description instead.");
      return;
    }
    const rec = new Ctor();
    recognition.current = rec;
    heard.current = "";
    rec.lang = "hi-IN";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event: RecognitionEventLike) => {
      let text = "";
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i]?.[0]?.transcript ?? "";
      }
      heard.current = text.trim();
    };
    rec.onerror = (event: RecognitionErrorLike) => {
      recognition.current = null;
      move("failed");
      setMessage(
        event.error === "not-allowed"
          ? "Microphone permission was denied. Type the description instead."
          : "Voice input failed. Type the description instead.",
      );
    };
    rec.onend = () => {
      recognition.current = null;
      // The platform ended the session on its own: settle and draft.
      if (statusRef.current !== "listening") return;
      const spokenText = heard.current.trim();
      if (spokenText === "") {
        move("failed");
        setMessage("Didn't catch that. Tap and speak again.");
        return;
      }
      move("drafting");
      void draft(spokenText);
    };
    move("listening");
    setMessage("");
    try {
      rec.start();
    } catch {
      recognition.current = null;
      move("failed");
      setMessage("Could not start the microphone. Type the description instead.");
    }
  }

  function onClick(): void {
    if (status === "listening") {
      stopAndDraft();
      return;
    }
    if (status === "drafting") return;
    if (status === "failed" && heard.current !== "") {
      void draft(heard.current);
      return;
    }
    start();
  }

  const label =
    status === "listening"
      ? "Stop and draft"
      : status === "drafting"
        ? "Drafting…"
        : status === "failed"
          ? heard.current !== ""
            ? "Retry draft"
            : "Try again"
          : "Speak description";

  const hint =
    status === "listening"
      ? "Listening… speak now, then tap Stop."
      : status === "drafting"
        ? "Turning your note into English…"
        : status === "failed"
          ? message
          : message !== ""
            ? message
            : "Speak in Hinglish — we draft the English description for you to review.";

  // Idle help is plain copy, NOT a live region — a form should announce only
  // what just changed (a listening/drafting/refused state), never its default
  // hint on every render.
  const live = status !== "idle" || message !== "";

  return (
    <div>
      <button
        type="button"
        className="bb-btn bb-btn--secondary bb-btn--sm"
        onClick={onClick}
        disabled={disabled || status === "drafting"}
      >
        <Icon name="sparkle" />
        {label}
      </button>
      <p className="form__hint" {...(live ? { role: "status" as const } : {})}>
        {hint}
      </p>
      {status === "failed" && heard.current !== "" ? (
        <button
          type="button"
          className="bb-btn bb-btn--secondary bb-btn--sm"
          onClick={() => void draft(heard.current)}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
