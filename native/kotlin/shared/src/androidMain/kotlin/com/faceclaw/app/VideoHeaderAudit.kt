package com.faceclaw.app

/** Validate fields parsed by FFmpeg trace_headers, not a second H.264 parser. */
class VideoHeaderAudit(private val deblocking: Boolean, private val fps: Int = 15,
    private val geometry: VideoFrameGeometry = VideoFrameGeometry(320,192)) {
    init { VideoEncodePlan.checkRate(fps) }
    private val fields = HashMap<String, Long>()
    private val sps = HashSet<Long>()
    private val pps = HashMap<Long, Long>()
    private var section = ""
    private var tail = ""
    private var failed: String? = null
    private var closed = false
    var slices = 0
        private set
    var parameterSets = 0
        private set
    private val valueLine = Regex("\\]\\s+\\d+\\s+([a-zA-Z0-9_]+)\\s+[01]+\\s*=\\s*(-?\\d+)\\s*$")

    /** Accept session-local log chunks; retained text is bounded independently of movie length. */
    @Synchronized fun accept(text: String) {
        if (closed || failed != null) return
        val joined = tail + text
        var start = 0
        for (i in joined.indices) if (joined[i] == '\n') {
            try { line(joined.substring(start, i).trimEnd('\r')) }
            catch (error: Throwable) { failed = error.message ?: "Invalid video headers" }
            start = i + 1
        }
        tail = joined.substring(start)
        if (tail.length > 8192) { failed = "Oversized FFmpeg header log line"; tail = "" }
    }
    private fun line(text: String) {
        if (!text.contains("[trace_headers")) return
        val next = when {
            text.endsWith("Sequence Parameter Set") -> "sps"
            text.endsWith("Picture Parameter Set") -> "pps"
            text.endsWith("Slice Header") -> "slice"
            text.contains("Packet:") || text.endsWith("Extradata") || text.endsWith("Supplemental Enhancement Information") -> "other"
            else -> null
        }
        if (next != null) { finishSection(); section = next; return }
        if (section == "other" || section.isEmpty()) return
        val match = valueLine.find(text) ?: return
        val name = match.groupValues[1]
        if (name.startsWith("rbsp_")) return
        val value = match.groupValues[2].toLong()
        val previous = fields.put(name, value)
        require(previous == null || previous == value) { "Conflicting parsed header field" }
    }
    private fun field(name: String): Long = checkNotNull(fields[name]) { "Missing parsed H.264 field: $name" }
    private fun equals(name: String, value: Long) { require(field(name) == value) { "Unsupported H.264 $name" } }
    private fun finishSection() {
        when (section) {
            "sps" -> {
                equals("profile_idc", 66); equals("max_num_ref_frames", 1)
                equals("pic_width_in_mbs_minus1", geometry.width / 16L - 1)
                equals("pic_height_in_map_units_minus1", geometry.height / 16L - 1)
                equals("frame_mbs_only_flag", 1); equals("frame_cropping_flag", 0)
                equals("vui_parameters_present_flag", 1); equals("video_signal_type_present_flag", 1)
                equals("video_full_range_flag", 1); equals("timing_info_present_flag", 1)
                equals("num_units_in_tick", 1); equals("time_scale", fps * 2L)
                equals("max_num_reorder_frames", 0)
                require(field("max_dec_frame_buffering") in 1..2) { "Unsupported decoder picture buffer" }
                require(field("seq_parameter_set_id") in 0..31)
                sps.add(field("seq_parameter_set_id")); parameterSets++
            }
            "pps" -> {
                equals("entropy_coding_mode_flag", 0); equals("num_slice_groups_minus1", 0)
                equals("weighted_pred_flag", 0); equals("weighted_bipred_idc", 0)
                equals("num_ref_idx_l0_default_active_minus1", 0); equals("num_ref_idx_l1_default_active_minus1", 0)
                equals("bottom_field_pic_order_in_frame_present_flag", 0)
                equals("deblocking_filter_control_present_flag", 1); equals("redundant_pic_cnt_present_flag", 0)
                require(fields["transform_8x8_mode_flag"] in listOf(null, 0L))
                val id = field("pic_parameter_set_id")
                val source = field("seq_parameter_set_id")
                require(id in 0..255 && source in sps) { "PPS lacks an active SPS" }
                pps[id] = source; parameterSets++
            }
            "slice" -> {
                equals("first_mb_in_slice", 0)
                require(field("slice_type") % 5 in listOf(0L, 2L) && field("nal_unit_type") in listOf(1L, 5L)) { "Unsupported video picture type" }
                require(field("pic_parameter_set_id") in pps) { "Slice lacks an active PPS" }
                equals("disable_deblocking_filter_idc", if (deblocking) 0 else 1)
                slices++
            }
        }
        fields.clear()
    }
    @Synchronized fun finish() {
        check(!closed) { "Video header audit already finished" }
        closed = true
        if (tail.isNotEmpty()) line(tail)
        check(failed == null) { failed!! }
        finishSection()
        require(slices > 0 && parameterSets >= 2) { "Incomplete FFmpeg header audit" }
    }
}
