import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.truestring.tuner',
  appName: 'TrueString',
  webDir: 'dist',
  backgroundColor: '#0f1317',
  android: {
    allowMixedContent: false,
  },
};

export default config;
