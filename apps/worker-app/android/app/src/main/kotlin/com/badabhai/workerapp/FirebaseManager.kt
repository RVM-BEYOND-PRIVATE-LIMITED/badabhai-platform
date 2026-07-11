package com.badabhai.workerapp

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Native-Android Firebase entry point.
 *
 * - Creates the notification channel used to display FCM messages (Android 8+).
 * - Logs the current FCM registration token so you can target THIS device from the
 *   Firebase console → Cloud Messaging → "Send test message" to verify push works.
 *
 * Call [init] once from MainActivity.onCreate(). Firebase itself auto-initialises via
 * the merged FirebaseInitProvider using google-services.json — this class only adds the
 * channel + token logging that a console test needs.
 */
object FirebaseManager {
    const val CHANNEL_ID = "bb_default_channel"
    private const val CHANNEL_NAME = "General Notifications"
    private const val TAG = "FirebaseManager"

    fun init(context: Context) {
        createNotificationChannel(context)
        logFcmToken()
    }

    private fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Default channel for app notifications"
            }
            context.getSystemService(NotificationManager::class.java)
                ?.createNotificationChannel(channel)
        }
    }

    private fun logFcmToken() {
        FirebaseMessaging.getInstance().token
            .addOnCompleteListener { task ->
                if (!task.isSuccessful) {
                    Log.w(TAG, "Fetching FCM token failed", task.exception)
                    return@addOnCompleteListener
                }
                Log.i(TAG, "FCM registration token: ${task.result}")
            }
    }
}
