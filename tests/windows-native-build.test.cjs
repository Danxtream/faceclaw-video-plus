const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function attemptedBuild(platform) {
  let invocation;
  const source = fs.readFileSync(path.join(__dirname, '../scripts/kotlin-build.cjs'), 'utf8');
  const module = { exports: {} };
  const requireModule = name => name === 'node:child_process' ? {
    spawn: (...args) => {
      invocation = args;
      return { on: (event, callback) => { if (event === 'exit') callback(1); } };
    },
  } : require(name);
  vm.runInNewContext(source, {
    module, require: requireModule, __dirname: path.join(__dirname, '../scripts'),
    process: { platform, env: { ComSpec: 'cmd.exe' } }, console: { log() {} },
  });
  await assert.rejects(module.exports.buildKotlin('android'), /Kotlin build failed/);
  return invocation;
}

test('Windows Kotlin build invokes the batch wrapper through cmd without dropping arguments', async () => {
  const [command, args, options] = await attemptedBuild('win32');
  assert.equal(command, 'cmd.exe');
  assert.deepEqual(Array.from(args.slice(0, 3)), ['/d', '/s', '/c']);
  assert.match(args[3], /^"".*gradlew\.bat" :shared:assembleAndroidMain --console=plain"$/);
  assert.equal(options.windowsVerbatimArguments, true);
});

test('Unix Kotlin build retains direct wrapper invocation', async () => {
  const [command, args, options] = await attemptedBuild('linux');
  assert.ok(command.endsWith('gradlew'));
  assert.deepEqual(Array.from(args), [':shared:assembleAndroidMain', '--console=plain']);
  assert.equal(options.windowsVerbatimArguments, false);
});

test('Native compiler selection changes only the Windows launcher and keeps Android API24', () => {
  const source = fs.readFileSync(path.join(__dirname, '../App_Resources/Android/app.gradle'), 'utf8');
  assert.match(source, /windowsHost = Os\.isFamily\(Os\.FAMILY_WINDOWS\)/);
  assert.match(source, /windowsHost \? 'clang\.exe' : 'aarch64-linux-android24-clang'/);
  assert.match(source, /windowsHost \? \["--target=aarch64-linux-android24"\] : \[\]/);
});
