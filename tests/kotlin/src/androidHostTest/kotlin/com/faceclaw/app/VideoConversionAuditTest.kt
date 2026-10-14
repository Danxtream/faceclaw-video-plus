package com.faceclaw.app

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertTrue

class VideoConversionAuditTest {
    private fun section(name: String, fields: Map<String, Long>): String = "[trace_headers @ test] $name\n" +
        fields.entries.joinToString("") { "[trace_headers @ test] 1 ${it.key} 101 = ${it.value}\n" }
    private val sps = linkedMapOf("profile_idc" to 66L, "max_num_ref_frames" to 1L, "pic_width_in_mbs_minus1" to 19L,
        "pic_height_in_map_units_minus1" to 11L, "frame_mbs_only_flag" to 1L, "frame_cropping_flag" to 0L,
        "vui_parameters_present_flag" to 1L, "video_signal_type_present_flag" to 1L, "video_full_range_flag" to 1L,
        "timing_info_present_flag" to 1L, "num_units_in_tick" to 1L, "time_scale" to 32L,
        "max_num_reorder_frames" to 0L, "max_dec_frame_buffering" to 1L, "seq_parameter_set_id" to 0L)
    private val pps = linkedMapOf("entropy_coding_mode_flag" to 0L, "num_slice_groups_minus1" to 0L,
        "weighted_pred_flag" to 0L, "weighted_bipred_idc" to 0L, "num_ref_idx_l0_default_active_minus1" to 0L,
        "num_ref_idx_l1_default_active_minus1" to 0L, "bottom_field_pic_order_in_frame_present_flag" to 0L,
        "deblocking_filter_control_present_flag" to 1L, "redundant_pic_cnt_present_flag" to 0L,
        "pic_parameter_set_id" to 0L, "seq_parameter_set_id" to 0L)
    private fun slice(db: Boolean) = mapOf("first_mb_in_slice" to 0L, "slice_type" to 7L, "nal_unit_type" to 5L,
        "pic_parameter_set_id" to 0L, "disable_deblocking_filter_idc" to if (db) 0L else 1L)

    @Test fun recipeIsFixedFullRangeAndDeblockingSelectionDoesNotChangeBitrate() {
        val off = VideoEncodePlan.arguments("input with spaces.mp4", "output.h264.part", false)
        val on = VideoEncodePlan.arguments("input with spaces.mp4", "output.h264.part", true)
        assertEquals("input with spaces.mp4", off[off.indexOf("-i") + 1])
        assertTrue(off.contains("libx264") && off.contains("baseline"))
        assertTrue(off[off.indexOf("-x264-params") + 1].endsWith(":no-deblock=1"))
        assertTrue(on[on.indexOf("-x264-params") + 1].endsWith(":deblock=0,0"))
        assertTrue(off[off.indexOf("-x264-params") + 1].contains("vbv-maxrate=110:vbv-bufsize=22"))
        assertTrue(off.none { it.contains("slice-max") || it.contains("cabac=1") })
        assertFails { VideoEncodePlan.arguments("same", "same", false) }
    }

    @Test fun chunkedFfmpegHeadersAuditAllParameterSetsAndSlices() {
        for (db in listOf(false, true)) {
            val audit = VideoHeaderAudit(db)
            val text = section("Sequence Parameter Set", sps) + section("Picture Parameter Set", pps) + section("Slice Header", slice(db))
            text.chunked(13).forEach(audit::accept)
            audit.finish()
            assertEquals(1, audit.slices); assertEquals(2, audit.parameterSets)
            assertFails { audit.finish() }
        }
    }

    @Test fun unsupportedOrUnsignalledFieldsAreRefusedInsteadOfRepaired() {
        val changes = listOf("profile_idc" to 100L, "video_signal_type_present_flag" to 0L,
            "video_full_range_flag" to 0L, "max_num_ref_frames" to 3L, "max_dec_frame_buffering" to 3L,
            "time_scale" to 60L, "frame_cropping_flag" to 1L)
        for ((field, value) in changes) {
            val audit = VideoHeaderAudit(false)
            audit.accept(section("Sequence Parameter Set", sps + (field to value)) +
                section("Picture Parameter Set", pps) + section("Slice Header", slice(false)))
            assertFails { audit.finish() }
        }
        for ((field, value) in listOf("entropy_coding_mode_flag" to 1L, "num_slice_groups_minus1" to 1L, "weighted_pred_flag" to 1L)) {
            val audit = VideoHeaderAudit(false)
            audit.accept(section("Sequence Parameter Set", sps) + section("Picture Parameter Set", pps + (field to value)) +
                section("Slice Header", slice(false)))
            assertFails { audit.finish() }
        }
        val mismatch = VideoHeaderAudit(false)
        mismatch.accept(section("Sequence Parameter Set", sps) + section("Picture Parameter Set", pps) + section("Slice Header", slice(true)))
        assertFails { mismatch.finish() }
    }

    @Test fun decodedAccessUnitsDeterminePicturesAndPreserveApplicableParameterSets() {
        val nals = listOf(7, 8, 6, 5, 1).mapIndexed { index, type -> VideoFileReader.Nal(index * 8L + 4, 4, type, "a".repeat(64)) }
        val audit = VideoFileReader.Audit(40, "b".repeat(64), nals)
        val frames = listOf(VideoDecodedPicture(0, 32, true, 320, 192, "yuvj420p", "I", 0, 0),
            VideoDecodedPicture(32, 8, false, 320, 192, "yuvj420p", "P", 0, 0))
        val map = VideoPictureMap.build(audit, frames)
        assertEquals(listOf(3, 4), map.map { it.nal })
        assertEquals(listOf(0L, 63L), map.map { it.pts })
        assertTrue(map.all { it.sps == 0 && it.pps == 1 })
        assertFails { VideoPictureMap.build(audit, frames.dropLast(1)) }
        assertFails { VideoPictureMap.build(audit, frames.map { it.copy(kind = "B") }) }
        assertFails { VideoPictureMap.build(audit.copy(nals = nals.mapIndexed { i, n -> if (i == 2) n.copy(type = 1) else n }), frames) }
        assertFails { VideoPictureMap.build(audit, frames.map { it.copy(bytes = 1) }) }
    }
}
