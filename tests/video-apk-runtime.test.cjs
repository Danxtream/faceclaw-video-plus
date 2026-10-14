const test = require('node:test');
const { execFileSync } = require('node:child_process');

test('APK runtime inspection distinguishes definitions from references and checks multidex', () => {
  execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    ['tests/test_video_apk_runtime.py'], { stdio: 'pipe' });
});
