// Script injected into the page to classify what the login flow is currently showing.
// It tags the elements it intends to fill with a per-run random attribute. Fill commands target that
// attribute, so if the page navigates between "look" and "type" the selector matches nothing and no
// secret is typed - and a hostile page cannot pre-plant the attribute because the nonce is unknown to it.
export const tagSel = (nonce, kind) => `[data-hp-${nonce}="${kind}"]`;

export function probeScript({ nonce, selectors = {}, successText = null }) {
  return String.raw`(() => {
const N = ${JSON.stringify(nonce)}, S = ${JSON.stringify(selectors)}, ST = ${JSON.stringify(successText)};
const attr = 'data-hp-' + N;
document.querySelectorAll('[' + attr + ']').forEach((e) => e.removeAttribute(attr));
const vis = (e) => {
  if (!e || !e.isConnected) return false;
  const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
  return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.05 && !e.disabled && e.type !== 'hidden';
};
const q = (sel) => { try { return [...document.querySelectorAll(sel)].filter(vis); } catch (_) { return []; } };
const meta = (e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.name || '') + ' ' + (e.id || '') + ' ' + (e.placeholder || '') + ' ' + (e.autocomplete || '') + ' ' + (e.getAttribute('data-testid') || '')).toLowerCase();
const inputs = [...document.querySelectorAll('input')].filter(vis);
// words that mark a username/email field, in English plus es/de/fr/pt/it/nl
const USERISH = /user|email|e-mail|mail|login|identifier|phone|usuario|correo|benutzer|nutzer|utilisateur|identifiant|courriel|utente|gebruiker|usu[aá]rio/;
const textish = (i) => i.type === 'email' || (['text', 'tel', 'number', ''].includes(i.type) && !/search|query/.test(meta(i)));

const pass = S.password ? q(S.password)[0] : inputs.find((i) => i.type === 'password');
const otp = S.otp ? q(S.otp)[0] : inputs.find((i) => i !== pass && textish(i) &&
  (i.autocomplete === 'one-time-code' || /otp|totp|one-time|verification|authenticator|2fa|mfa|security.?code|\bcode\b|\bpin\b|c[oó]digo|best[aä]tigung|sicherheitscode|codice|verificatiecode/.test(meta(i))) && !USERISH.test(meta(i)));
const user = S.username ? q(S.username)[0] : inputs.find((i) => i !== pass && i !== otp && textish(i) &&
  (i.type === 'email' || i.autocomplete === 'username' || USERISH.test(meta(i))));

const primary = pass || otp || user;
let submit = null;
if (primary) {
  if (S.submit) submit = q(S.submit)[0];
  if (!submit) {
    const scope = primary.form || primary.closest('form') || primary.closest('[role=dialog],main,section,div') || document;
    const cands = [...scope.querySelectorAll('button, input[type=submit], [role=button]')].filter(vis);
    const label = (b) => ((b.innerText || b.value || b.getAttribute('aria-label') || '') + '').trim().toLowerCase();
    const bad = /google|github|apple|microsoft|facebook|twitter|sso|passkey|forgot|create|sign.?up|register|back|cancel|resend|another|help|show|hide|toggle|olvid|vergessen|oubli|esquec|dimentic|vergeten|crear|registr|erstellen|cr[eé]er|inscri|criar|cadastr|aanmaken|ayuda|hilfe|aide|ajuda|aiuto|atr[aá]s|zur[uü]ck|retour|voltar|indietro|cancelar|abbrechen|annuler/;
    const good = /^(next|continue|sign.?in|log.?in|submit|verify|confirm|send|done|go|enter|siguiente|continuar|iniciar|acceder|entrar|ingresar|weiter|anmelden|einloggen|suivant|continuer|connexion|se connecter|avan[cç]ar|pr[oó]ximo|continua|avanti|accedi|volgende|inloggen)\b/;
    const ok = cands.filter((b) => !bad.test(label(b)));
    submit = ok.find((b) => b.type === 'submit' && good.test(label(b))) || ok.find((b) => good.test(label(b))) || ok.find((b) => b.type === 'submit');
  }
}
if (user) user.setAttribute(attr, 'user');
if (pass) pass.setAttribute(attr, 'pass');
if (otp) otp.setAttribute(attr, 'otp');
if (submit) submit.setAttribute(attr, 'submit');

const body = ((document.body && document.body.innerText) || '').slice(0, 6000);
const capSrc = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|geetest|captcha/i;
const capFrame = [...document.querySelectorAll('iframe')].filter(vis).some((f) => (capSrc.test(f.src || '') || capSrc.test(f.title || '')) && !f.closest('.grecaptcha-badge'));
const capText = /verify (that )?you('| a)re (a )?human|i'?m not a robot|are you a robot|unusual traffic|checking your browser|just a moment|security check|press and hold|no soy un robot|verifica que eres (un )?humano|comprobaci[oó]n de seguridad|ich bin kein roboter|ein mensch sind|sicherheitspr[uü]fung|je ne suis pas un robot|v[eé]rification de s[eé]curit[eé]|n[aã]o sou um rob[oô]|non sono un robot|ik ben geen robot/i.test(body);
// Deliberately narrow: only phrases typical of a challenge page, so dashboards that merely mention
// "security key" or "authenticator app" in settings are not mistaken for an MFA wall.
const mfaText = /2-step verification|two-step verification|check your (phone|email|inbox)|approve (the |this )?(sign.?in|request|login)|verify it'?s you|enter the (6-digit )?code|sent (you )?an? (text|code|email)|confirm your identity|verificaci[oó]n en dos pasos|c[oó]digo de verificaci[oó]n|revisa tu (tel[eé]fono|correo)|best[aä]tigung in zwei schritten|zwei-faktor|best[aä]tigungscode|validation en deux [eé]tapes|code de v[eé]rification|v[eé]rifiez votre identit[eé]|verifica[cç][aã]o em duas etapas|c[oó]digo de verifica[cç][aã]o|verifica in due passaggi|codice di verifica|verificatie in twee stappen/i.test(body);
const errEls = [...document.querySelectorAll('[role=alert], [aria-live=assertive], [class*=error i], [id*=error i], [class*=invalid i]')].filter(vis);
const errText = /incorrect|invalid|wrong|doesn.?t match|not recognized|couldn.?t find|could not find|try again|failed|locked|too many|inv[aá]lid|falsch|ung[uü]ltig|invalide|erron|errad[oa]|sbagliat|errata|onjuist|ongeldig|no coincide|stimmt nicht|ne correspond pas|n[aã]o confere|demasiados intentos|zu viele versuche|trop de tentatives/i.test(errEls.map((e) => e.innerText || '').join(' '));

// Does this look like a sign-in page even if it has no form fields (e.g. only "Continue with Google" buttons)?
const loginish = /\/(log-?in|sign-?in|signin|sign_in|sso|auth|authenticate|identifier|oauth2?|iniciar-?sesi[oó]n|inicio-?sesi[oó]n|acceso|anmelden|anmeldung|einloggen|connexion|se-?connecter|entrar|accesso|inloggen)(\/|$)/i.test(location.pathname) ||
  /^(accounts|login|signin|auth|sso|id)\./i.test(location.hostname) ||
  /^\s*(sign.?in|log.?in|iniciar sesi|inicia sesi|acceder|anmelden|einloggen|connexion|se connecter|entrar|accedi|inloggen)/i.test(document.title || '');

return JSON.stringify({
  url: location.href, origin: location.origin, title: document.title,
  user: !!user, pass: !!pass, otp: !!otp, submit: submit ? 'click' : (primary ? 'enter' : null),
  captcha: capFrame || capText, mfa: mfaText, error: errText,
  successText: ST ? body.toLowerCase().includes(String(ST).toLowerCase()) : null,
  loginish: loginish,
  ready: document.readyState,
});
})()`;
}
