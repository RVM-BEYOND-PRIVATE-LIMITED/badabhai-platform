"use client";

import { QRCodeSVG } from "qrcode.react";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * The authenticator set-up block: a QR code to scan and the key to type by hand.
 *
 * Shared by the sign-in authenticator step (an admin with two-step verification on who has not
 * enrolled yet) and the Account page's "turn on" flow, so the two never drift apart.
 *
 * The secret arrives ONCE from a Server Action and lives only in the calling component's state:
 * never persisted, never logged, gone when the form unmounts. The QR keeps a light plate in every
 * theme (`.enroll__qr`) so it always scans.
 */
export function AuthenticatorEnrollment({
  secret,
  otpauthUri,
}: {
  secret: string;
  otpauthUri: string;
}) {
  return (
    <div className="enroll">
      <div className="enroll__qr">
        <QRCodeSVG
          value={otpauthUri}
          size={168}
          level="M"
          title="QR code for your authenticator app"
        />
      </div>
      <details className="enroll__manual">
        <summary>
          <Icon name={ACTION_ICON.disclosure} className="disclosure__caret" />
          Can&apos;t scan? Enter the key manually
        </summary>
        <code className="enroll__secret">{secret}</code>
        <p className="field__help">
          This key is shown once and is not recoverable. If you lose your device, another super
          admin must reset your MFA.
        </p>
      </details>
    </div>
  );
}
