package com.badabhai.workerapp

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.WindowManager
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

class MainActivity : FlutterActivity() {

    /** OTP SMS auto-read (Play Services User Consent). Android-only. */
    private var smsOtp: SmsUserConsentManager? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyScreenCaptureBlock()
        FirebaseManager.init(this)
        requestNotificationPermissionIfNeeded()
    }

    /**
     * Blocks OS screenshots and screen recording for the whole app (#353).
     *
     * Flutter renders every route into this ONE activity, so the flag is
     * necessarily app-wide — and that is the posture we want. The worker app
     * shows a 4-digit PIN keypad, the OTP code next to the raw phone number, and
     * the decrypted full name on the resume/name screens. Any app holding
     * MediaProjection or an accessibility capture service — rampant in the
     * sideload-heavy low-end Android segment this product targets — can
     * otherwise record a PIN + OTP + phone, which is enough to take the account
     * over from the same device. OS screenshots of those screens also sync
     * straight to Google Photos (a DPDP exposure).
     *
     * DEFAULT-DENY on purpose: gating per-route would mean enumerating every
     * sensitive screen and silently losing protection the day someone adds a new
     * PII screen and forgets to opt in. The worker loses nothing real — the
     * resume is downloadable as a PDF (#256), which is the honest way to share
     * it.
     *
     * DEBUGGABLE builds are exempt so development and QA can still capture
     * evidence; the shipped release build is always protected. Keyed off
     * FLAG_DEBUGGABLE rather than BuildConfig.DEBUG, which is not generated
     * unless the module opts into the buildConfig feature.
     */
    private fun applyScreenCaptureBlock() {
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (debuggable) return
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        // OTP SMS auto-read (Play Services User Consent). Channel name MUST match
        // SmsOtpAutofill.channelName on the Dart side.
        val smsChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, SMS_OTP_CHANNEL)
        val smsManager = SmsUserConsentManager(this, smsChannel)
        smsOtp = smsManager
        smsChannel.setMethodCallHandler { call, result -> smsManager.handle(call, result) }

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
                    // #465 — pdf_downloader.dart STILL sends "displayName" over
                    // this channel (its call site is shared and unchanged), and
                    // we deliberately never read it. The resume file name is the
                    // worker's real legal name; not binding it here is what keeps
                    // it out of the notification path entirely. An unread arg key
                    // is inert to MethodChannel, so the contract stays compatible.
                    "notifyDownloadComplete" -> notifyDownloadComplete(
                        displayPath = call.argument<String>("displayPath"),
                        location = call.argument<String>("location"),
                        result = result,
                    )
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
        // displayPath is the human-readable "where is my file" line. Only this
        // side truly knows: MediaStore hands back an opaque content:// uri, which
        // is meaningless to a worker looking for their PDF.
        return mapOf(
            "location" to uri.toString(),
            "displayName" to finalName,
            "public" to true,
            "displayPath" to "${Environment.DIRECTORY_DOWNLOADS}/$finalName",
        )
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
        // Below API 29 the file lives in the app-external dir, NOT public
        // Downloads — say so with the real path rather than implying Downloads.
        // Trimmed to the storage-relative part: the absolute /storage/emulated/0
        // prefix is noise to a worker browsing their files.
        val displayPath = target.absolutePath.substringAfter("/0/", target.absolutePath)
        return mapOf(
            "location" to target.absolutePath,
            "displayName" to target.name,
            "public" to false,
            "displayPath" to displayPath,
        )
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
            startActivity(viewIntentFor(location))
            result.success(true)
        } catch (e: ActivityNotFoundException) {
            result.success(false)
        } catch (e: Exception) {
            result.success(false)
        }
    }

    /**
     * ACTION_VIEW on an already-SAVED LOCAL file — a `content://` MediaStore uri
     * directly, or a pre-29 fallback path through this app's FileProvider.
     *
     * Shared by "Kholein" and the download notification's tap, deliberately: the
     * two must open the file the SAME way, and duplicating the uri/flag handling
     * is how they would quietly stop matching.
     *
     * PRIVACY: takes a LOCAL location only. A remote signed url never reaches
     * this side of the channel, so none can end up in a PendingIntent the OS
     * retains.
     */
    private fun viewIntentFor(location: String): Intent {
        val uri: Uri = if (location.startsWith("content://")) {
            Uri.parse(location)
        } else {
            FileProvider.getUriForFile(this, "$packageName.downloads.fileprovider", File(location))
        }
        return Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/pdf")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    /**
     * Posts the "download finished, here is where it went" notification — the
     * thing the system Download Manager gives you and an in-app download does
     * not. The SnackBar is gone the moment the worker leaves the screen; this is
     * what they still have an hour later when they want to find the file.
     *
     * BEST-EFFORT BY CONTRACT: it ALWAYS result.success(...) and never throws.
     * The download already succeeded — the file is on disk — so a notification
     * problem (permission denied, OEM quirk, channel blocked) must never turn a
     * finished download into a failure. Returns whether it actually posted, so
     * the Dart side can tell "shown" from "silently skipped".
     *
     * Tap opens the saved file via [viewIntentFor] — identical to "Kholein".
     *
     * PRIVACY (#465 / TD85): NOTHING here is derived from the worker's name.
     * Since #398 the resume file name IS the worker's real legal name
     * (RAM_KUMAR_SHARMA_RESUME.pdf), so the old title (displayName), text and
     * bigText (displayPath) each wrote that name into the OS notification store.
     * VISIBILITY_PRIVATE was the old mitigation and it only ever governed
     * lock-screen RENDERING — it does nothing about NotificationListenerService,
     * which any app the worker has granted notification access reads every posted
     * notification with, needing no further permission and giving the worker no
     * signal. In the sideload-heavy low-end Android segment this product targets,
     * the booster/"cleaner" utilities that ask for that access as a matter of
     * course are exactly that app — the same threat model [applyScreenCaptureBlock]
     * invokes to justify app-wide FLAG_SECURE. So this notification now names the
     * FOLDER, never the file. The real name stays where it is useful and bounded:
     * on disk, and in the in-app SnackBar (downloadCompleteNoticeFor).
     *
     * TD85 is logged "awaiting security ruling" on whether the OS notification
     * store counts as a CLAUDE.md §2 sink. This lands ahead of that ruling on
     * purpose: it is strictly PII-REDUCING and costs the worker nothing — the tap
     * still opens the file, so discoverability is untouched — so it cannot be
     * wrong in the harmful direction whichever way the ruling lands.
     */
    private fun notifyDownloadComplete(
        displayPath: String?,
        location: String?,
        result: MethodChannel.Result,
    ) {
        try {
            if (displayPath == null || location == null) {
                result.success(false)
                return
            }
            val manager = NotificationManagerCompat.from(this)
            if (!manager.areNotificationsEnabled()) {
                // Android 13+ needs POST_NOTIFICATIONS. Ask HERE, at the moment
                // the value is self-evident ("your file saved — want to be told
                // where?"), rather than relying only on the cold startup prompt,
                // which arrives with no context and is reflexively dismissed.
                //
                // This cannot nag: the guard is a no-op once granted, and Android
                // itself stops showing the dialog after two dismissals and
                // auto-denies. THIS download is never blocked on the answer — it
                // is already saved, so we fall back to the SnackBar and the next
                // download gets the notification.
                requestNotificationPermissionIfNeeded()
                result.success(false)
                return
            }
            createDownloadsChannel()

            // Name the FOLDER, never the file (#465). displayPath is
            // "Download/RAM_KUMAR_SHARMA_RESUME.pdf" on API 29+ (or the pre-29
            // app-external equivalent); everything BEFORE the last '/' is pure
            // directory and carries no name. Derived rather than hard-coding
            // "Downloads" because below API 29 the file genuinely is NOT in
            // public Downloads (see [saveToAppExternalDownloads]) — asserting it
            // was would send the worker hunting in a folder their PDF isn't in.
            val folder = displayPath.substringBeforeLast('/', "")
            val body = if (folder.isEmpty()) {
                "File save ho gayi — kholne ke liye tap karein"
            } else {
                "$folder folder mein save ho gayi — kholne ke liye tap karein"
            }

            // Per-download id, derived from NOTHING (#465). This was
            // displayPath.hashCode() — i.e. an id computed from the worker's own
            // name, sitting in the same notification record a listener service
            // reads; a 32-bit hash of a known "NAME_RESUME.pdf" shape is
            // guessable against a name list, so the hash leaked what the title
            // just stopped leaking. A counter gives the uniqueness the id existed
            // for — a resume and a kit downloaded back to back must both stay in
            // the shade, and a second download's tap must not inherit the first
            // file's intent through FLAG_UPDATE_CURRENT — while deriving from no
            // worker data at all. It also can't collide the way a hash can.
            // Accepted trade: the counter restarts with the process, so a much
            // later download can replace a stale receipt from a previous run.
            // These are auto-cancelling "where did it go" receipts, and the newer
            // one is the one the worker just asked for.
            val notificationId = downloadNotificationSeq.getAndIncrement()

            val pendingIntent = PendingIntent.getActivity(
                this,
                notificationId,
                viewIntentFor(location),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

            val notification = NotificationCompat.Builder(this, DOWNLOADS_NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                // Not "Resume download complete": this ONE channel method serves
                // the resume AND the interview kit, and the Kotlin side is never
                // told which. A generic title is the only one that is always true
                // — and it happens to say less, which is the point.
                .setContentTitle("Download complete")
                .setContentText(body)
                // BigTextStyle KEPT — but over the folder-only [body], never the
                // file path it used to expand (#465). Dropping it entirely was an
                // over-correction that broke the notification on exactly the
                // devices this product targets: below API 29 the file lives at
                // "Android/data/com.badabhai.workerapp/files/Download", and
                // setContentText is a single ELLIPSIZED line, so an API 24-28
                // worker saw "Android/data/com.badabhai.work…" and learned
                // nothing. A directory is not PII, so expanding it costs no
                // privacy and restores the notification's only job: say where the
                // file went.
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                // PUBLIC now, and that is an upgrade, not a relaxation: the
                // content is generic, so redacting it on the lock screen would
                // replace a useful "where's my file" line with "Contents hidden"
                // and defeat the notification's only job. If anyone ever puts the
                // file name back in here, this must go back to VISIBILITY_PRIVATE
                // — but the real answer is: don't put the file name back in here.
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setContentIntent(pendingIntent)
                .build()

            manager.notify(notificationId, notification)
            result.success(true)
        } catch (e: Exception) {
            // Never let a notification problem fail a finished download.
            result.success(false)
        }
    }

    /** The "Downloads" channel — separate from the FCM one so a worker can mute
     *  download receipts without losing real alerts. */
    private fun createDownloadsChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            DOWNLOADS_NOTIFICATION_CHANNEL_ID,
            "Downloads",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "Tells you where a downloaded resume or interview kit was saved"
        }
        getSystemService(NotificationManager::class.java)
            ?.createNotificationChannel(channel)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        // Consume the SMS-consent result; anything else belongs to the plugins.
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
        private const val DOWNLOADS_CHANNEL = "badabhai.workerapp/downloads"

        /** Notification channel for download receipts — NOT the FCM channel. */
        private const val DOWNLOADS_NOTIFICATION_CHANNEL_ID = "bb_downloads_channel"

        /**
         * Supplies the per-download notification / PendingIntent id (#465).
         * Atomic because [notifyDownloadComplete] is reachable from the platform
         * thread while a [saveToDownloads] worker thread is still in flight.
         */
        private val downloadNotificationSeq = AtomicInteger(1)
    }
}
