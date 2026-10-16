package com.faceclaw.app

/** Fixed high-effort recipe apart from the chosen clip cadence. */
object VideoEncodePlan {
    const val ENCODER = "dev.ffmpegkit-maintained:ffmpeg-kit-min-gpl:8.1.7"
    // Fit the source inside 320x192 at its own shape and fill the rest with black; stretching made
    // tall videos about three times too wide. Padding in full-range gray keeps the bars at Y 0, the
    // video's own black (the firmware's default curve shows it as panel level 1, its dimmest lit
    // level). FFmpeg turns rotation-flagged phone recordings upright first.
    private const val FILTER = "scale=320:192:force_original_aspect_ratio=decrease:force_divisible_by=2:" +
        "flags=lanczos:in_range=auto:out_range=full,format=gray,pad=320:192:(ow-iw)/2:(oh-ih)/2:color=black,format=yuvj420p"
    private const val RECIPE = "scenecut=0:crf=12:" +
        "aq-mode=2:aq-strength=1.0:chroma-qp-offset=-2:subme=8:trellis=2:me=hex:merange=16:" +
        "rc-lookahead=50:ipratio=0.50:vbv-maxrate=110:vbv-bufsize=22:threads=1:range=pc"

    /** Refuse unsupported recipes before starting a foreground job. */
    fun checkRate(fps: Int) { require(fps in listOf(10, 15, 20)) { "Choose 10, 15 or 20 fps and re-convert this clip" } }
    @JvmStatic fun arguments(input: String, output: String, deblocking: Boolean, fps: Int = 15): Array<String> {
        checkRate(fps)
        require(input.isNotBlank() && output.isNotBlank() && input != output && !input.contains('\u0000') && !output.contains('\u0000'))
        return arrayOf("-nostdin", "-v", "error", "-y", "-i", input, "-map", "0:v:0", "-an",
            "-vf", "fps=$fps,$FILTER", "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuvj420p", "-color_range", "pc",
            // Preserve eight-second GOPs; x264's minimum is half a GOP plus one picture.
            "-x264-params", "ref=1:bframes=0:weightp=0:8x8dct=0:cabac=0:keyint=${fps * 8}:min-keyint=${fps * 4 + 1}:" +
                RECIPE + if (deblocking) ":deblock=0,0" else ":no-deblock=1", "-f", "h264", output)
    }
}

/** A decoded FFprobe picture, not an input transport NAL. */
data class VideoDecodedPicture(val offset: Long, val bytes: Long, val key: Boolean,
    val width: Int, val height: Int, val pixelFormat: String, val kind: String, val interlaced: Int, val repeat: Int)
data class VideoPictureTime(val pts: Long, val nal: Int, val idr: Boolean, val sps: Int, val pps: Int)

/** Join decoded access-unit offsets to the bounded native scan, one VCL per picture. */
object VideoPictureMap {
    fun build(audit: VideoFileReader.Audit, decoded: List<VideoDecodedPicture>, fps: Int = 15): List<VideoPictureTime> {
        VideoEncodePlan.checkRate(fps)
        require(decoded.isNotEmpty()) { "Converter decoded no pictures" }
        val result = ArrayList<VideoPictureTime>()
        var index = 0
        var sps = -1
        var pps = -1
        var lastIdr = -1
        var packetEnd = 0L
        for ((ordinal, frame) in decoded.withIndex()) {
            require(frame.offset >= packetEnd && frame.bytes > 0 && frame.offset <= audit.bytes - frame.bytes &&
                frame.width == 320 && frame.height == 192 && frame.pixelFormat in listOf("yuv420p", "yuvj420p") &&
                frame.kind in listOf("I", "P") && frame.interlaced == 0 && frame.repeat == 0) { "Unsupported or inconsistent decoded picture" }
            packetEnd = frame.offset + frame.bytes
            var finishing = -1
            while (index < audit.nals.size && audit.nals[index].offset < packetEnd) {
                val nal = audit.nals[index]
                require(nal.offset >= frame.offset && nal.offset + nal.bytes <= packetEnd) { "NAL crosses decoded access-unit bounds" }
                when (nal.type) {
                    7 -> sps = index
                    8 -> pps = index
                    1, 5 -> { require(finishing < 0) { "Multiple slices per picture are unsupported" }; finishing = index }
                }
                index++
            }
            require(finishing >= 0 && sps >= 0 && pps >= 0 && sps < finishing && pps < finishing) { "Decoded picture lacks parameter sets or finishing NAL" }
            val idr = audit.nals[finishing].type == 5
            require(frame.key == idr && (!idr || frame.kind == "I")) { "Decoded keyframe does not match IDR" }
            if (idr) lastIdr = ordinal
            require(lastIdr >= 0 && ordinal - lastIdr <= 255) { "Decoded GOP exceeds hidden seek bound" }
            result.add(VideoPictureTime((ordinal * 1000L + fps / 2) / fps, finishing, idr, sps, pps))
        }
        require(audit.nals.drop(index).none { it.type == 1 || it.type == 5 }) { "Unmapped encoded picture" }
        return result
    }
}
