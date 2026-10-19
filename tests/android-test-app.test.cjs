const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}, globals = {}) {
  const context = { exports: {}, require: name => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

test('Normal build configuration is unchanged and the second identity is explicit opt-in', () => {
  for (const value of [undefined, '', '0', 'false', 'true']) {
    const config = load('nativescript.config.ts', {}, { process: { env: { FACECLAW_TEST_APP: value } } }).default;
    assert.deepEqual(JSON.parse(JSON.stringify(config)), {
      id: 'com.faceclaw.app', appPath: 'app', appResourcesPath: 'App_Resources',
      android: { v8Flags: '--expose_gc', markingMode: 'none' },
    });
  }
  const config = load('nativescript.config.ts', {}, { process: { env: { FACECLAW_TEST_APP: '1' } } }).default;
  assert.equal(config.id, 'com.faceclaw.app.test');
});

test('The build label switch preserves normal resource references and labels every test entry point', () => {
  const gradle = fs.readFileSync('App_Resources/Android/app.gradle', 'utf8');
  assert.match(gradle, /System\.getenv\("FACECLAW_TEST_APP"\) == "1"/);
  assert.match(gradle, /faceclawAppLabel: faceclawTestApp \? "Faceclaw 2" : "@string\/app_name"/);
  assert.match(gradle, /faceclawActivityLabel: faceclawTestApp \? "Faceclaw 2" : "@string\/title_activity_kimera"/);
  assert.doesNotMatch(gradle, /applicationIdSuffix|signingConfig\s*[={]/);
  const manifest = fs.readFileSync('App_Resources/Android/src/main/AndroidManifest.xml', 'utf8');
  assert.equal((manifest.match(/android:label="\$\{faceclawAppLabel\}"/g) || []).length, 2);
  assert.equal((manifest.match(/android:label="\$\{faceclawActivityLabel\}"/g) || []).length, 1);
  assert.match(manifest, /android:authorities="\$\{applicationId\}\.fileprovider"/);
  assert.match(manifest, /android:name="com\.faceclaw\.app\.FaceclawSettingsPortReceiver"/);
  assert.match(manifest, /android:name="com\.faceclaw\.app\.FaceclawMediaNotificationListenerService"/);
});

test('Runtime components and private data derive their owning package from Context', () => {
  const java = 'App_Resources/Android/src/main/java/com/faceclaw/app/';
  for (const name of ['FaceclawEvenAppDetector', 'FaceclawMediaController']) {
    assert.match(fs.readFileSync(java + name + '.java', 'utf8'),
      /new ComponentName\(appContext, FaceclawMediaNotificationListenerService\.class\)/);
  }
  const settings = fs.readFileSync(java + 'FaceclawSettingsPortReceiver.java', 'utf8');
  assert.match(settings, /getApplicationInfo\(\)\.dataDir/);
  assert.match(settings, /getExternalFilesDir\(null\)/);
  assert.match(fs.readFileSync('app/apps/evenhub/privacy-policy.ts', 'utf8'), /getPackageName\(\).*fileprovider/);
  assert.match(fs.readFileSync('app/native/foreground-service.ts', 'utf8'),
    /new android\.content\.Intent\(context, com\.faceclaw\.app\.FaceclawForegroundService\.class\)/);
});

test('A fresh Android firmware check only offers installation until the user taps', async () => {
  for (const kind of ['custom', 'older-faceclaw', 'other-custom', 'flashable-stock',
    'newer-stock-validated', 'newer-stock-unvalidated', 'unknown']) {
    const navigations = [];
    let probes = 0;
    class Observable { notifyPropertyChange() {} }
    class Probe { async run() { probes++; return {}; } onStateChange() {} close() {} }
    const { OnboardingFirmwareCheckViewModel } = load('app/phone-ui/onboarding-firmware-check-view-model.ts', {
      '../g2/reconnect-policy': { resumeAutoReconnect() {} },
      './onboarding-navigation': { finishOnboardingNavigation() {} },
      '@nativescript/core': { Observable, Frame: { topmost: () => ({ navigate: target => navigations.push(target) }) } },
      '../native/ble-permissions': { async ensureBlePermissions() {} },
      '../g2/device-addresses': { isValidMacAddress: () => true, loadDeviceAddresses: () => ({ right: 'right', left: 'left' }) },
      '../g2/firmware-builder': { hasExtractedEvenHubFonts: () => true,
        downloadAndExtractEvenHubFonts: () => assert.fail('Unexpected font download') },
      '../g2/firmware-compat': { classifyOnboardingFirmware: () => ({ kind, version: '2.2.9.22', extension: { kind: 'faceclaw', version: 1 } }),
        describeFirmwareExtension: () => 'test', BASE_STOCK_VERSION_TEXT: '2.2.9.22', REQUIRED_FACECLAW_FIRMWARE_VERSION: 1 },
      '../native/device-info-probe': { DeviceInfoProbe: Probe },
      './onboarding-state': { setOnboardingCompleted() {}, setPreviewOnlyMode() {} },
      '../util/format-error': { formatErrorMessage: String },
    }, { global: { isAndroid: true, isIOS: false } });
    const model = new OnboardingFirmwareCheckViewModel();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(probes, 1);
    assert.equal(navigations.length, 0, `Automatic navigation for ${kind}`);
    if (model.primaryLabel === 'Install Firmware' || model.primaryLabel === 'Proceed Anyway') {
      model.onPrimaryTap();
      assert.equal(navigations.length, 1);
      assert.equal(navigations[0].moduleName, 'phone-ui/onboarding-flash-page');
    }
    model.dispose();
  }
});
