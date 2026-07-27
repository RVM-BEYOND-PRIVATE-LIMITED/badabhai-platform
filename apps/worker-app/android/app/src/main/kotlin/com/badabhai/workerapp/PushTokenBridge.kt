package com.badabhai.workerapp

import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

object PushTokenBridge {
    private const val CHANNEL = "badabhai/push_token"
    private const val TAG = "PushTokenBridge"

    private var channel: MethodChannel? = null
    private var latestToken: String? = null

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
        channel?.invokeMethod("tokenUpdated", token)
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
