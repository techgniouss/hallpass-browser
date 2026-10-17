// Everything hallpass prints passes through here. Secrets are scrubbed in raw, JSON-escaped,
// URL-encoded and base64 forms, so a page or tool that echoes them back still shows nothing.
export class Redactor {
  constructor() { this.needles = new Set(); }
  add(value) {
    if (typeof value !== 'string' || value.length < 4) return;
    const forms = [
      value,
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
      encodeURI(value),
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('base64').replace(/=+$/, ''),
    ];
    for (const f of forms) if (f.length >= 4) this.needles.add(f);
  }
  scrub(text) {
    if (typeof text !== 'string') return text;
    let out = text;
    // longest first so a form that contains a shorter one is not left half-redacted
    for (const n of [...this.needles].sort((a, b) => b.length - a.length)) out = out.split(n).join('[REDACTED]');
    return out;
  }
  scrubDeep(v) {
    if (typeof v === 'string') return this.scrub(v);
    if (Array.isArray(v)) return v.map((x) => this.scrubDeep(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.scrubDeep(x)]));
    return v;
  }
}
