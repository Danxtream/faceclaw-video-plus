import { NativeScriptConfig } from '@nativescript/core';

export default {
  id: process.env.FACECLAW_TEST_APP === '1' ? 'com.faceclaw.app.test' : 'com.faceclaw.app',
  appPath: 'app',
  appResourcesPath: 'App_Resources',
  android: {
    v8Flags: '--expose_gc',
    markingMode: 'none'
  }
} as NativeScriptConfig;
