const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

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
