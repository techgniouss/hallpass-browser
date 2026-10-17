// Runs the mock site in its own process (tests that drive a browser synchronously would otherwise starve it).
import { startSite } from './mock-site.mjs';

const s = await startSite({ user: 'u@example.test', password: 'unused-password-1', totpCfg: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 } });
process.stdout.write(String(s.port) + '\n');
process.stdin.resume(); // live until the parent closes our stdin
process.stdin.on('end', () => { s.close(); process.exit(0); });
