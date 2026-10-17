import readline from 'node:readline';

export const isTTY = () => !!(process.stdin.isTTY && process.stderr.isTTY);

export function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}

// Hidden input, read straight from the terminal. Nothing is echoed and nothing lands in shell history.
export function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk) => {
      if (chunk.charCodeAt(0) === 27) return; // arrow/function keys arrive as escape sequences; never let them into the secret
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { done(); return resolve(buf); }
        if (ch === '\u0003') { done(); return reject(new Error('cancelled')); }
        if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function readAllStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
