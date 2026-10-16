package com.faceclaw.app

import kotlin.math.roundToInt

/** The visible picture is fitted without cropping inside an audited coded canvas. */
data class VideoFrameGeometry(val width: Int, val height: Int, val x: Int = 0, val y: Int = 0,
    val pictureWidth: Int = width, val pictureHeight: Int = height) {
    init {
        require((width == 320 && height in listOf(176,192) || width == 144 && height == 240) &&
            x >= 0 && y >= 0 && pictureWidth > 0 && pictureHeight > 0 &&
            x.toLong() + pictureWidth <= width && y.toLong() + pictureHeight <= height) { "Unsupported video geometry" }
    }
    companion object {
        /** Orientation is automatic for both landscape canvas choices. FFmpeg autorotates first. */
        fun fit(sourceWidth: Int, sourceHeight: Int, sar: String = "1:1", rotation: Int = 0,
            landscapeHeight: Int = 176): VideoFrameGeometry {
            require(sourceWidth > 0 && sourceHeight > 0 && landscapeHeight in listOf(176,192))
            val ratio = if (sar in listOf("N/A", "0:1", "")) listOf(1.0,1.0) else sar.split(':').map(String::toDouble)
            require(ratio.size == 2 && ratio.all { it.isFinite() && it > 0 }) { "Unsupported source pixel aspect ratio" }
            require(rotation % 90 == 0) { "Unsupported source rotation" }
            var aspect = sourceWidth.toDouble() / sourceHeight * ratio[0] / ratio[1]
            if ((rotation % 180 + 180) % 180 != 0) aspect = 1 / aspect
            require(aspect.isFinite() && aspect > 0) { "Invalid source display shape" }
            val width = if (aspect < 1) 144 else 320
            val height = if (aspect < 1) 240 else landscapeHeight
            val pw: Int; val ph: Int
            if (aspect >= width.toDouble()/height) { pw = width; ph = (width/aspect).roundToInt().coerceIn(1,height) }
            else { ph = height; pw = (height*aspect).roundToInt().coerceIn(1,width) }
            return VideoFrameGeometry(width,height,(width-pw)/2,(height-ph)/2,pw,ph)
        }
    }
}

/**
 * How a color picture becomes the glasses' gray, chosen per conversion.
 * Medium and High were picked by eye on the glasses (2026-10-16): skin in bright scenes
 * showed too few shades with the standard luma mix.
 */
enum class VideoContrast(val id: String) {
    /** Standard luma, as every earlier conversion. */
    DEFAULT("default"),
    /** The green channel alone, so skin's color differences also become brightness steps. */
    MEDIUM("medium"),
    /** Medium plus a local-contrast boost. */
    HIGH("high");

    companion object {
        fun of(id: String): VideoContrast = entries.firstOrNull { it.id == id }
            ?: throw IllegalArgumentException("Choose Default, Medium or High contrast")
    }
}

/** Fixed high-effort recipe apart from the chosen clip cadence. */
object VideoEncodePlan {
    const val ENCODER = "dev.ffmpegkit-maintained:ffmpeg-kit-min-gpl:8.1.7"
    // Keyframes get a normal budget: ipratio 0.50 with a 22 kbit buffer made each keyframe about
    // 4.5 dB worse than the pictures before it, a visible blur every 8 s that took ~8 pictures to
    // recover. A 32 kbit buffer keeps every picture under the 4,086-byte NAL limit (largest
    // measured 3.6 KB) while the 110 kbps cap stays.
    private const val RECIPE = "scenecut=0:crf=12:" +
        "aq-mode=2:aq-strength=1.0:chroma-qp-offset=-2:subme=8:trellis=2:me=hex:merange=16:" +
        "rc-lookahead=50:ipratio=1.00:vbv-maxrate=110:vbv-bufsize=32:threads=1:range=pc"
    // Y + 0.8 * (Y - blur), with the boost fading only within 64 levels of the end it would push
    // toward, so bright skin still gains darker texture but nothing new clips to white or black.
    // lut2 evaluates the expression once into a table; a per-pixel blend expression gave the same
    // pictures but made the whole conversion about 26% slower.
    private const val HIGH_BOOST = "split[o][s];[s]gblur=sigma=3[bl];[o][bl]lut2=c0=" +
        "'clip(x+0.8*(x-y)*if(gt(x\\,y)\\,min(1\\,(255-x)/64)\\,min(1\\,x/64))\\,0\\,255)'"

    /** Refuse unsupported recipes before starting a foreground job. */
    fun checkRate(fps: Int) { require(fps in listOf(10, 15, 20)) { "Choose 10, 15 or 20 fps and re-convert this clip" } }
    @JvmStatic fun arguments(input: String, output: String, deblocking: Boolean, fps: Int = 15,
        geometry: VideoFrameGeometry = VideoFrameGeometry(320,192), contrast: VideoContrast = VideoContrast.DEFAULT): Array<String> {
        checkRate(fps)
        require(input.isNotBlank() && output.isNotBlank() && input != output && !input.contains('\u0000') && !output.contains('\u0000'))
        val size = "scale=${geometry.pictureWidth}:${geometry.pictureHeight}:flags=lanczos:in_range=auto"
        val gray = when (contrast) {
            VideoContrast.DEFAULT -> "$size:out_range=full,format=gray"
            VideoContrast.MEDIUM -> "$size,format=gbrp,extractplanes=g"
            VideoContrast.HIGH -> "$size,format=gbrp,extractplanes=g,$HIGH_BOOST"
        }
        // Gray permits odd picture edges before the final even-sized 4:2:0 canvas.
        val filter = "$gray,setsar=1," +
            "pad=${geometry.width}:${geometry.height}:${geometry.x}:${geometry.y}:color=black,format=yuvj420p"
        return arrayOf("-nostdin", "-v", "error", "-y", "-i", input, "-map", "0:v:0", "-an",
            "-vf", "fps=$fps,$filter", "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuvj420p", "-color_range", "pc",
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
    fun build(audit: VideoFileReader.Audit, decoded: List<VideoDecodedPicture>, fps: Int = 15,
        geometry: VideoFrameGeometry = VideoFrameGeometry(320,192)): List<VideoPictureTime> {
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
                frame.width == geometry.width && frame.height == geometry.height && frame.pixelFormat in listOf("yuv420p", "yuvj420p") &&
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
