import { readBrowserAccount } from '../src/features/x-search/browser-reader.js';

try {
  const page = await readBrowserAccount(process.argv[2], { profileDir: process.env.X_BROWSER_PROFILE,
    chromePath: process.env.X_BROWSER_CHROME || '/usr/bin/google-chrome', diagnostics: process.env.X_BROWSER_DIAGNOSTICS === '1', signal: AbortSignal.timeout(45000) });
  console.log(JSON.stringify(page));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
