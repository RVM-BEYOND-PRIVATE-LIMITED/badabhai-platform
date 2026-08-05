package com.badabhai.workerapp

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

object PushTokenBridge {
    private const val CHANNEL = "badabhai/push_token"
    private const val TAG = "PushTokenBridge"

    private var channel: MethodChannel? = null
    private var latestToken: String? = null

    /** MethodChannel calls are @UiThread — marshal onto main from FCM background threads. */
    private val mainHandler = Handler(Looper.getMainLooper())

    fun init(messenger: BinaryMessenger) {
        channel = MethodChannel(messenger, CHANNEL).apply {
            setMethodCallHandler { call, result ->
                when (call.method) {
                    "getToken" -> {
                        val token = latestToken
                        if (token != null) {
                            result.success(token)
                        } else {
                            fetchToken(result)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
        }
        preloadToken()
    }

    fun onTokenUpdated(token: String) {
        latestToken = token
        Log.i(TAG, "Token updated")
        // onNewToken fires on an FCM background thread ("Firebase-Messaging-Intent-Handle");
        // MethodChannel.invokeMethod hits FlutterJNI.ensureRunningOnMainThread and throws off
        // the main thread. Marshal onto main so a token rotation never crashes the app.
        mainHandler.post { channel?.invokeMethod("tokenUpdated", token) }
    }

    private fun preloadToken() {
        FirebaseMessaging.getInstance().token
            .addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    latestToken = task.result
                }
            }
    }

    private fun fetchToken(result: MethodChannel.Result) {
        FirebaseMessaging.getInstance().token
            .addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    val token = task.result
                    latestToken = token
                    result.success(token)
                } else {
                    result.success(null)
                }
            }
    }
}
