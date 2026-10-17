// Helper for the native-dialog test: shows the real approval dialog and prints the choice (or "null").
import { ask } from '../src/ui.mjs';

const choice = ask({
  title: 'Hallpass: approve sign-in',
  message: 'An AI agent (test) wants to sign in using your stored login "demo".\n\nThe password will only ever be typed into: https://demo.test',
  buttons: [{ id: 'deny', label: 'Deny' }, { id: 'hour', label: 'Allow for 1 hour' }, { id: 'once', label: 'Allow once' }],
  timeoutSec: 60,
});
process.stdout.write(String(choice));
