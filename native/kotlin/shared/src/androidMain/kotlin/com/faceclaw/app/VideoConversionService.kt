package com.faceclaw.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/** Foreground conversion survives phone UI backgrounding and never needs glasses. */
class VideoConversionService : Service() {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var job: VideoConversion? = null
    private var wake: PowerManager.WakeLock? = null
    private var lastNotification = 0L
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == CANCEL) { job?.cancel(); return START_NOT_STICKY }
        if (intent?.action != START || job != null) return START_NOT_STICKY
        val path = intent.getStringExtra("source") ?: return START_NOT_STICKY
        try {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, "Video conversion", NotificationManager.IMPORTANCE_LOW))
            val note = notification("Preparing", 0.0)
            if (Build.VERSION.SDK_INT >= 35) startForeground(ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING)
            else if (Build.VERSION.SDK_INT >= 29) startForeground(ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else startForeground(ID, note)
            wake = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "faceclaw:video-conversion")
            wake!!.acquire(6 * 60 * 60 * 1000L)
            val conversion = VideoConversion(File(path), intent.getBooleanExtra("deblocking", false), intent.getBooleanExtra("overwrite", false)) { stage, progress ->
                state = JSONObject().put("running", true).put("stage", stage).put("progress", progress).put("source", path).toString()
                val now = System.currentTimeMillis()
                if (now - lastNotification >= 500) {
                    lastNotification = now
                    main.post { if (job != null) manager.notify(ID, notification(stage, progress)) }
                }
            }
            job = conversion
            state = JSONObject().put("running", true).put("stage", "preparing").put("progress", 0).put("source", path).toString()
            worker.submit {
                try {
                    val result = conversion.run()
                    state = JSONObject().put("running", false).put("stage", "complete").put("progress", 1).put("output", result.path).toString()
                } catch (error: Throwable) {
                    state = JSONObject().put("running", false).put("stage", "failed").put("progress", 0).put("error", error.message ?: error.toString()).toString()
                } finally { main.post { job = null; finish() } }
            }
        } catch (error: Throwable) {
            state = JSONObject().put("running", false).put("stage", "failed").put("progress", 0).put("error", error.toString()).toString()
            finish()
        }
        return START_NOT_STICKY
    }
    private fun notification(stage: String, progress: Double): Notification {
        val cancel = PendingIntent.getService(this, 0, Intent(this, VideoConversionService::class.java).setAction(CANCEL),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        return builder.setSmallIcon(android.R.drawable.stat_sys_upload).setContentTitle("Video conversion").setContentText(stage)
            .setOngoing(true).setProgress(100, (progress * 100).toInt(), progress <= 0)
            .addAction(Notification.Action.Builder(null, "Cancel", cancel).build()).build()
    }
    private fun finish() {
        wake?.let { if (it.isHeld) it.release() }; wake = null
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    override fun onTimeout(startId: Int, fgsType: Int) { job?.cancel(); finish() }
    override fun onDestroy() { job?.cancel(); worker.shutdown(); wake?.let { if (it.isHeld) it.release() }; wake = null; super.onDestroy() }
    companion object {
        private const val START = "com.faceclaw.app.VIDEO_CONVERSION_START"
        private const val CANCEL = "com.faceclaw.app.VIDEO_CONVERSION_CANCEL"
        private const val CHANNEL = "faceclaw-video-conversion"
        private const val ID = 4202
        @Volatile private var state = "{\"running\":false,\"stage\":\"idle\",\"progress\":0}"
        @JvmStatic fun snapshotJson(): String = state
        @JvmStatic fun start(context: Context, source: String, deblocking: Boolean, overwrite: Boolean) {
            val intent = Intent(context, VideoConversionService::class.java).setAction(START).putExtra("source", source)
                .putExtra("deblocking", deblocking).putExtra("overwrite", overwrite)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
        @JvmStatic fun cancel(context: Context) { context.startService(Intent(context, VideoConversionService::class.java).setAction(CANCEL)) }
    }
}
