package com.badabhai.payerapp

import android.Manifest
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyScreenCaptureBlock()
        FirebaseManager.init(this)
        requestNotificationPermissionIfNeeded()
    }

    /**
     * #353 — block screenshots and screen recording for the whole app.
     *
     * The payer app renders the email-OTP login code and, after an unlock, the
     * revealed candidate contact and masked-resume surface — the exact material a
     * screen-recorder or an OS screenshot must not capture. Any app holding
     * MediaProjection/accessibility capture can otherwise record these, and a
     * screenshot syncs straight to Google Photos.
     *
     * Applied at the WINDOW level for every screen rather than per-route: a
     * per-screen opt-in silently loses protection the day someone adds a new PII
     * screen and forgets to opt in. Mirrors the worker-app fix verbatim.
     *
     * DEBUGGABLE builds are exempt so development and QA can still capture
     * evidence; the shipped release build is always protected. Keyed off
     * FLAG_DEBUGGABLE rather than BuildConfig.DEBUG, which is not generated unless
     * the module opts into the buildConfig feature.
     */
    private fun applyScreenCaptureBlock() {
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (debuggable) return
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
    }

    /** Android 13+ requires the POST_NOTIFICATIONS runtime grant before pushes can show. */
    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIF_PERMISSION_REQUEST)
        }
    }

    companion object {
        private const val NOTIF_PERMISSION_REQUEST = 2001
    }
}
