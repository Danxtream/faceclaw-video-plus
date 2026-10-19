# Side-by-side Android App

Set `FACECLAW_TEST_APP=1` in the environment of the normal NativeScript
Android build command to build **Faceclaw 2** (`com.faceclaw.app.test`).
Unset it, or set it to `0`, for the normal Faceclaw build. Only the exact
value `1` opts in. Use the same signing options as the normal build.
This option does not install an app or change any glasses firmware.

The native Java/Kotlin classes remain in `com.faceclaw.app`. NativeScript
uses the selected application ID; its metadata still exposes those same
native classes. FileProvider derives its authority from `${applicationId}`.
Services and notification-listener components use the application context
and their fully qualified native class names. Preferences, databases and
private files belong to the selected Android package, not to a shared copy.

## Limits

- The normal Wear OS remote does not pair with Faceclaw 2: the wearable
  data layer requires matching package names as well as signing keys.
- Settings, permissions, notification access, pairing selections and cached
  fonts/models are separate. A fresh install does not inherit normal app
  settings. Configure the second glasses pair explicitly.
- Existing PC settings/onboarding/frame-timing scripts target the normal
  package. They are unchanged. To address the test settings receiver, use
  the explicit component
  `com.faceclaw.app.test/com.faceclaw.app.FaceclawSettingsPortReceiver`;
  its action strings stay `com.faceclaw.app.SETTINGS_EXPORT` and
  `com.faceclaw.app.SETTINGS_IMPORT`. Do not use the relative `.ClassName`
  shorthand with the test application ID.
- Explicit alarm, foreground-service and converter intents keep their
  existing action strings; their component's owning package isolates them.
  Shared files selected by the user are not private duplicated settings.
- Both installations can remain on the phone, but this does not isolate
  the phone's Bluetooth adapter or guarantee simultaneous BLE capacity.
  Avoid configuring both apps to reconnect to the same glasses pair.

## Firmware Safety

Onboarding reads and classifies firmware and offers an install action; it
does not automatically enter the flash flow. Entering that flow requires
the user's tap, and writing requires the existing on-glasses approval and
battery checks. Compatible firmware may require preparing phone-side fonts,
which is not a glasses flash. No firmware delta is changed by this option.
