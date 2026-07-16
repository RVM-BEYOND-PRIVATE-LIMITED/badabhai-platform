package com.badabhai.workerapp

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

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
        // In-app PDF download channel (resume / interview-kit). Both methods deal
        // ONLY in local files — the short-lived SIGNED url is fetched on the Dart
        // side and never crosses this channel, so nothing here can log or persist
        // its token (CLAUDE.md §2 posture).
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, DOWNLOADS_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "saveToDownloads" -> saveToDownloads(
                        tempPath = call.argument<String>("tempPath"),
                        fileName = call.argument<String>("fileName"),
                        mimeType = call.argument<String>("mimeType") ?: "application/pdf",
                        result = result,
                    )
                    "openSavedFile" -> openSavedFile(call.argument<String>("location"), result)
                    else -> result.notImplemented()
                }
            }
    }

    /**
     * Copies an already-downloaded temp file into the device's PUBLIC Downloads
     * collection via MediaStore (API 29+ — needs NO storage permission), or into
     * the app-external Download dir below API 29 (also permission-free; avoids
     * the legacy WRITE_EXTERNAL_STORAGE prompt). The copy runs off the main
     * thread. Returns {location, displayName, public}.
     */
    private fun saveToDownloads(
        tempPath: String?,
        fileName: String?,
        mimeType: String,
        result: MethodChannel.Result,
    ) {
        if (tempPath == null || fileName == null) {
            result.error("bad_args", "tempPath and fileName are required", null)
            return
        }
        val mainHandler = Handler(Looper.getMainLooper())
        Thread {
            try {
                val source = File(tempPath)
                val saved: Map<String, Any> =
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        saveViaMediaStore(source, fileName, mimeType)
                    } else {
                        saveToAppExternalDownloads(source, fileName)
                    }
                mainHandler.post { result.success(saved) }
            } catch (e: Exception) {
                // Deliberately detail-free: an exception message could embed a
                // path; the Dart side shows its own typed, worker-safe copy.
                mainHandler.post { result.error("save_failed", "could not save the file", null) }
            }
        }.start()
    }

    /** API 29+: MediaStore de-duplicates DISPLAY_NAME itself ("name (1).pdf"). */
    @RequiresApi(Build.VERSION_CODES.Q)
    private fun saveViaMediaStore(source: File, fileName: String, mimeType: String): Map<String, Any> {
        val resolver = applicationContext.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("MediaStore insert failed")
        try {
            resolver.openOutputStream(uri)?.use { out ->
                source.inputStream().use { it.copyTo(out) }
            } ?: throw IllegalStateException("openOutputStream failed")
        } catch (e: Exception) {
            // Don't leave a 0-byte pending row behind in Downloads.
            resolver.delete(uri, null, null)
            throw e
        }
        values.clear()
        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
        // Report the display name MediaStore actually chose after dedup.
        var finalName = fileName
        resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) finalName = c.getString(0) ?: fileName
        }
        return mapOf("location" to uri.toString(), "displayName" to finalName, "public" to true)
    }

    /** API 24–28 fallback: app-external Download dir, explicit "(1)" dedup. */
    private fun saveToAppExternalDownloads(source: File, fileName: String): Map<String, Any> {
        val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: File(filesDir, "Download")
        if (!dir.exists()) dir.mkdirs()
        val dot = fileName.lastIndexOf('.')
        val base = if (dot > 0) fileName.substring(0, dot) else fileName
        val ext = if (dot > 0) fileName.substring(dot) else ""
        var target = File(dir, fileName)
        var n = 1
        while (target.exists()) {
            target = File(dir, "$base ($n)$ext")
            n++
        }
        source.copyTo(target)
        return mapOf("location" to target.absolutePath, "displayName" to target.name, "public" to false)
    }

    /**
     * Opens an already-SAVED local PDF in the device viewer via ACTION_VIEW —
     * a `content://` MediaStore uri directly, or a file path through this app's
     * FileProvider (pre-29 fallback files). Never receives a remote url.
     * Returns false when no installed app can display a PDF.
     */
    private fun openSavedFile(location: String?, result: MethodChannel.Result) {
        if (location == null) {
            result.error("bad_args", "location is required", null)
            return
        }
        try {
            val uri: Uri = if (location.startsWith("content://")) {
                Uri.parse(location)
            } else {
                FileProvider.getUriForFile(this, "$packageName.downloads.fileprovider", File(location))
            }
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/pdf")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(intent)
            result.success(true)
        } catch (e: ActivityNotFoundException) {
            result.success(false)
        } catch (e: Exception) {
            result.success(false)
        }
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
        private const val DOWNLOADS_CHANNEL = "badabhai.workerapp/downloads"
    }
}
