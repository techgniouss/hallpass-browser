import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function home() {
  const dir = process.env.HALLPASS_HOME || path.join(os.homedir(), '.hallpass');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export const sub = (...p) => {
  const dir = path.join(home(), ...p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};
export const entriesDir = () => sub('entries');
export const profilesDir = () => sub('profiles');
export const stateDir = () => sub('state');
