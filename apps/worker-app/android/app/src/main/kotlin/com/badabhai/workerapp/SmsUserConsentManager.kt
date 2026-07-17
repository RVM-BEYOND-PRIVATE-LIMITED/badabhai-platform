package com.badabhai.workerapp

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Android half of the OTP auto-read, over Play Services **SMS User Consent**.
 *
 * Why User Consent and not the silent SMS Retriever: Retriever only delivers an
 * SMS whose body carries our 11-char app hash, and the DLT-approved template
 * ("Your OTP is 895218. Do not share it. - RVM Beyond Private Limited") has no
 * hash. User Consent needs no hash and no READ_SMS permission — the OS shows a
 * one-tap prompt and then hands us exactly one message.
 *
 * Flow: [start] opens a 5-minute window -> Play Services broadcasts
 * SMS_RETRIEVED_ACTION with a consent Intent -> we show it -> on RESULT_OK the
 * user's tap gives us the body, which we forward to Dart as `onSms`.
 *
 * Never logs the SMS body (it contains the live OTP).
 */
class SmsUserConsentManager(
    private val activity: Activity,
    private val channel: MethodChannel,
) {

    private var receiver: BroadcastReceiver? = null

    fun handle(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "start" -> {
                start()
                result.success(null)
            }
            "stop" -> {
                stop()
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun start() {
        stop() // never stack windows/receivers across a resend

        // null sender = accept from ANY sender. Required here: our OTP arrives
        // from an alphanumeric DLT header ("JM-RVMOTP-T"), not a phone number,
        // so there is no number to filter on.
        //
        // The listeners log ONLY whether the window opened — never the SMS body
        // or the code. Without them a device with broken/absent Play Services
        // fails completely silently and looks identical to "no SMS arrived".
        SmsRetriever.getClient(activity).startSmsUserConsent(null)
            .addOnSuccessListener { Log.i(TAG, "SMS consent window opened") }
            .addOnFailureListener { e -> Log.w(TAG, "SMS consent window failed to open", e) }

        val created = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
                val extras = intent.extras ?: return
                val status = extras.parcelable(SmsRetriever.EXTRA_STATUS, Status::class.java)
                when (status?.statusCode) {
                    CommonStatusCodes.SUCCESS -> {
                        Log.i(TAG, "matching SMS found — showing consent prompt")
                        val consent =
                            extras.parcelable(SmsRetriever.EXTRA_CONSENT_INTENT, Intent::class.java)
                                ?: return
                        try {
                            activity.startActivityForResult(consent, REQ_CONSENT)
                        } catch (_: Exception) {
                            // Activity gone / no handler — manual entry still works.
                            stop()
                        }
                    }
                    // 5-minute window elapsed with no matching SMS.
                    CommonStatusCodes.TIMEOUT -> {
                        Log.i(TAG, "SMS consent window timed out (no matching SMS)")
                        stop()
                    }
                }
            }
        }

        val filter = IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION)
        // SEND_PERMISSION means only Play Services can deliver this broadcast, so
        // another app cannot inject a fake OTP. The receiver MUST be exported —
        // the sender is outside our process (Android 13+ makes the flag explicit).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.registerReceiver(
                created, filter, SmsRetriever.SEND_PERMISSION, null, Context.RECEIVER_EXPORTED,
            )
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            activity.registerReceiver(created, filter, SmsRetriever.SEND_PERMISSION, null)
        }
        receiver = created
    }

    fun stop() {
        receiver?.let {
            try {
                activity.unregisterReceiver(it)
            } catch (_: IllegalArgumentException) {
                // Already unregistered — nothing to undo.
            }
        }
        receiver = null
    }

    /**
     * Returns true when this result was ours (so the caller skips super), false
     * to let Flutter plugins handle it.
     */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQ_CONSENT) return false
        if (resultCode == Activity.RESULT_OK) {
            val message = data?.getStringExtra(SmsRetriever.EXTRA_SMS_MESSAGE)
            if (!message.isNullOrEmpty()) channel.invokeMethod("onSms", message)
        }
        // Denied or consumed: either way the window is done.
        stop()
        return true
    }

    private companion object {
        /** Distinct from MainActivity's notification-permission request (2001). */
        const val REQ_CONSENT = 2002
        const val TAG = "BbSmsOtp"
    }
}

/** API-33-safe [android.os.Bundle.getParcelable]. */
private fun <T> android.os.Bundle.parcelable(key: String, clazz: Class<T>): T? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        getParcelable(key, clazz)
    } else {
        @Suppress("DEPRECATION")
        getParcelable(key) as? T
    }
