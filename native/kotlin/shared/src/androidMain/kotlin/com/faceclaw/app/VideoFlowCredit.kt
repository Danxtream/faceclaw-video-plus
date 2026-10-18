package com.faceclaw.app

/** A live snapshot tied to one exact NAL, owner and notification ingress. */
internal data class VideoFlowCredit(val side: Int, val sequence: Int, val raw: ByteArray)

/** The upload worker owns these monotonic grants; notifications only copy them. */
internal class VideoFlowBudget(private val stream: Long, private val tokens: LongArray) {
    private val rows = arrayOfNulls<VideoFlowCredit>(2)
    val capacity: Int get() = rows.filterNotNull().minOfOrNull { it.raw[7].toInt() and 255 } ?: 4
    fun accept(grant: VideoFlowCredit, sent: Int, pictures: Int): Pair<Int, Int>? {
        check(grant.side in 1..2 && grant.sequence >= -1 && grant.sequence < sent && grant.raw.size == 16) {
            "Invalid video flow identity"
        }
        val raw = grant.raw
        val expected = VideoUploadEngine.word(raw, 0)
        val free = raw[6].toInt() and 255
        val capacity = raw[7].toInt() and 255
        val ordinal = VideoUploadEngine.word(raw, 8)
        val packed = raw[4].toInt() and 255
        check(VideoUploadEngine.word(raw, 12) == tokens[grant.side - 1] &&
            capacity in listOf(4, 6, 12) && free <= capacity &&
            expected <= grant.sequence + 1L && expected <= sent &&
            (packed shr 4 and 7) == 2 && packed and 128 == 0 &&
            (raw[5].toInt() and 31) == 0 && (raw[5].toInt() and 255) shr 5 <= 6 &&
            ordinal <= pictures) { "Video owner flow window failed stream=$stream side=${grant.side}" }
        val old = rows[grant.side - 1]
        if (old != null && grant.sequence <= old.sequence) return null
        check(sent - expected <= capacity && pictures - ordinal <= 6) {
            "Video owner flow credit distance failed"
        }
        check(old == null || expected >= VideoUploadEngine.word(old.raw, 0) &&
            ordinal >= VideoUploadEngine.word(old.raw, 8)) { "Video flow consumption regressed" }
        rows[grant.side - 1] = grant
        if (rows.any { it == null }) return null
        var nals = 12; var frames = 6
        for (row in rows.filterNotNull()) {
            val data = row.raw
            val consumed = VideoUploadEngine.word(data, 0)
            nals = minOf(nals, (data[6].toInt() and 255) - (sent - row.sequence - 1),
                ((data[7].toInt() and 255) + consumed - sent).toInt())
            frames = minOf(frames, ((data[5].toInt() and 255) shr 5) -
                (pictures - VideoUploadEngine.word(data, 8)).toInt())
        }
        return maxOf(0, nals) to maxOf(0, frames)
    }
    fun expected(side: Int): Long = rows[side - 1]?.let { VideoUploadEngine.word(it.raw, 0) } ?: -1
}
