const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

test('The runtime, native converter and host tests use only the same exact encoder pin', () => {
  const coordinate = 'dev.ffmpegkit-maintained:ffmpeg-kit-min-gpl:8.1.7';
  for (const file of ['App_Resources/Android/app.gradle', 'native/kotlin/shared/build.gradle.kts', 'tests/kotlin/build.gradle.kts']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(source.split(coordinate).length, 2);
    assert.ok(!source.includes('com.arthenica:ffmpeg-kit'));
  }
  const notices = fs.readFileSync('ACKNOWLEDGEMENTS.md', 'utf8');
  assert.ok(notices.includes(coordinate));
  assert.ok(notices.includes('GPL-2.0-or-later'));
  assert.ok(notices.includes('corresponding source'));
});

test('The omitted encoder exception runtime is explicitly pinned with its license', () => {
  const pins = JSON.parse(fs.readFileSync('scripts/video-runtime-artifacts.json', 'utf8'));
  for (const file of ['App_Resources/Android/app.gradle', 'native/kotlin/shared/build.gradle.kts', 'tests/kotlin/build.gradle.kts']) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pin of Object.values(pins)) {
      assert.equal(source.split(pin.coordinate).length, 2, `${file}: ${pin.coordinate}`);
      assert.match(pin.sha256, /^[a-f0-9]{64}$/);
      assert.ok(pin.url.startsWith('https://repo.maven.apache.org/maven2/'));
    }
  }
  const notices = fs.readFileSync('ACKNOWLEDGEMENTS.md', 'utf8');
  assert.ok(notices.includes(pins.smart_java.coordinate));
  assert.ok(notices.includes(pins.smart_common.coordinate));
  assert.ok(notices.includes('BSD-3-Clause'));
  const license = fs.readFileSync('app/licenses/smart-exception-LICENSE.txt');
  assert.ok(notices.replace(/\r\n/g, '\n').includes(license.toString('utf8')));
  assert.equal(crypto.createHash('sha256').update(license).digest('hex'),
    '6f175f503ff4cd705891a490c86bd4282256076cdb293cfb4bc26453188f15ff');
});
