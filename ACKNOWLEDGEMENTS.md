Acknowledgements
================

Faceclaw is an open source project, at https://github.com/jimrandomh/faceclaw.
Contributors include:
    James Babcock <jimrandomh@gmail.com>
    Kalani Helekunihi <i@am.guru>


Many thanks to g2-kit-unofficial: https://github.com/Commute773/g2-kit-unofficial/,
evenRealities-openCFW https://github.com/kalanihelekunihi/evenRealities-openCFW/,
and others who contributed to documenting the G2's bluetooth protocol and firmware.

G2 microphone LC3 decoding uses Google's liblc3: https://github.com/google/liblc3

The Terminus font is by Dimitar Zhekov's Terminus: https://framagit.org/ohnonot/terv-terc
and is distributed under the SIL Open Font License; see app/fonts/terminus/LICENSE.

The TerminusV proportional font is by ohnonot, derived from Terminus:
https://framagit.org/ohnonot/terv-terc. It is also distributed under the SIL
Open Font License; see app/fonts/terminusv/LICENSE.

The CJK font is Source Han Sans SC Light by Adobe:
https://github.com/adobe-fonts/source-han-sans. It is distributed under the SIL
Open Font License, Version 1.1; see app/fonts/source-han-sans/LICENSE.txt.
Faceclaw includes the G2's serialized 20 px LVGL build of the font so
phone-side rendering matches the glasses.

Video conversion uses the maintained FFmpegKit Min GPL Android artifact
dev.ffmpegkit-maintained:ffmpeg-kit-min-gpl:8.1.7, distributed as GPL-3.0:
https://github.com/ffmpegkit-maintained/ffmpeg
The artifact includes FFmpeg (GPL-enabled build) and VideoLAN's x264
(GPL-2.0-or-later): https://ffmpeg.org and https://www.videolan.org/developers/x264.html
Their original license resources remain bundled in the Android dependency.
Public APK distribution requires matching corresponding source for this
exact artifact and its external libraries; the bundled source notice alone
does not establish that match.
