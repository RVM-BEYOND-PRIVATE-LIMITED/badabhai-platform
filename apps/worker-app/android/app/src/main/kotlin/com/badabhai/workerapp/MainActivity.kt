package com.badabhai.workerapp

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {

    /** OTP SMS auto-read (Play Services User Consent). Android-only. */
    private var smsOtp: SmsUserConsentManager? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        FirebaseManager.init(this)
        requestNotificationPermissionIfNeeded()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Channel name MUST match SmsOtpAutofill.channelName on the Dart side.
        val channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, SMS_OTP_CHANNEL)
        val manager = SmsUserConsentManager(this, channel)
        smsOtp = manager
        channel.setMethodCallHandler { call, result -> manager.handle(call, result) }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        // Consume our own consent result; anything else belongs to the plugins.
        if (smsOtp?.onActivityResult(requestCode, resultCode, data) == true) return
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onDestroy() {
        // Unregister the consent receiver with the Activity — a leaked receiver
        // would throw on the next register after a rotate/relaunch.
        smsOtp?.stop()
        smsOtp = null
        super.onDestroy()
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
        private const val SMS_OTP_CHANNEL = "badabhai/sms_otp"
    }
}
