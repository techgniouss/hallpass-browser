// Detection corpus: structural re-creations of common sign-in pages (NOT captured copies of the real sites).
// Each entry says what the page probe must report. `wall` is what the engine derives: does this need a login/person?
// Known gaps are asserted too, so they stay visible instead of silently regressing or being forgotten.
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

export const FIXTURES = [
  { name: 'github-like', path: '/login', html: page('Sign in to GitHub', '<h1>Sign in</h1><form><label>Username or email address<input name="login" id="login_field" type="text" autocomplete="username"></label><label>Password<input name="password" id="password" type="password" autocomplete="current-password"></label><input type="submit" name="commit" value="Sign in"></form><a href="/password_reset">Forgot password?</a>'),
    expect: { user: true, pass: true, otp: false, captcha: false, mfa: false, wall: true, submit: 'click' } },

  { name: 'google-step1-email', path: '/v3/signin/identifier', html: page('Sign in - Google Accounts', '<form><input type="email" id="identifierId" name="identifier" aria-label="Email or phone" autocomplete="username"><button type="button">Next</button><a href="/f">Forgot email?</a><button type="button">Create account</button></form>'),
    expect: { user: true, pass: false, otp: false, wall: true, submit: 'click' } },

  { name: 'google-step2-password', path: '/v3/signin/challenge/pwd', html: page('Sign in - Google Accounts', '<form><input type="password" name="Passwd" aria-label="Enter your password" autocomplete="current-password"><button type="button">Next</button><button type="button">Forgot password?</button></form>'),
    expect: { pass: true, wall: true, submit: 'click' } },

  { name: 'microsoft-step1', path: '/common/oauth2/authorize', html: page('Sign in to your account', '<h1>Sign in</h1><input type="email" name="loginfmt" placeholder="Email, phone, or Skype" autocomplete="username"><button type="submit">Next</button><a href="#">Can\'t access your account?</a>'),
    expect: { user: true, pass: false, wall: true, submit: 'click' } },

  { name: 'okta-widget', path: '/signin', html: page('Acme - Sign In', '<form><input name="identifier" type="text" autocomplete="username"><input name="credentials.passcode" type="password" autocomplete="current-password"><input type="submit" value="Sign in"></form>'),
    expect: { user: true, pass: true, wall: true } },

  { name: 'auth0-universal', path: '/u/login', html: page('Log in | Acme', '<form><input id="username" name="username" type="email" autocomplete="email"><input id="password" name="password" type="password"><button type="submit" name="action" value="default">Continue</button><button type="button">Continue with Google</button></form>'),
    expect: { user: true, pass: true, wall: true, submit: 'click' } },

  { name: 'wordpress-login', path: '/wp-login.php', html: page('Log In &lsaquo; My Site', '<form><input type="text" name="log" id="user_login"><input type="password" name="pwd" id="user_pass"><input type="submit" name="wp-submit" id="wp-submit" value="Log In"></form>'),
    expect: { user: true, pass: true, wall: true } },

  { name: 'aws-iam-known-gap', path: '/signin', html: page('Amazon Web Services Sign-In', '<form><input name="account" type="text" placeholder="Account ID or alias"><input name="username" type="text"><input name="password" type="password"><button type="submit">Sign in</button></form>'),
    expect: { user: true, pass: true, wall: true }, note: 'detected as a login, but the Account ID field is not filled: AWS IAM needs a site recipe (roadmap #7)' },

  { name: 'sso-buttons-only', path: '/start', html: page('Sign in', '<h1>Welcome</h1><button>Continue with Google</button><button>Continue with GitHub</button><button>Continue with SAML SSO</button>'),
    expect: { user: false, pass: false, otp: false, wall: true } },

  { name: 'otp-code-page', path: '/auth/verify', html: page('Verify', '<form><input name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code"><button type="submit">Verify</button></form>'),
    expect: { otp: true, wall: true, submit: 'click' } },

  { name: 'recaptcha-v2-checkbox', path: '/login', html: page('Sign in', '<form><input type="email" name="email"><input type="password" name="password"><iframe src="/recaptcha/api2/anchor?k=x" title="reCAPTCHA" width="304" height="78"></iframe><button type="submit">Sign in</button></form>'),
    expect: { captcha: true, wall: true } },

  { name: 'recaptcha-v3-badge-only', path: '/login', html: page('Sign in', '<form><input type="email" name="email"><input type="password" name="password"><button type="submit">Sign in</button></form><div class="grecaptcha-badge" style="position:fixed;bottom:0;right:0"><iframe src="/recaptcha/api2/anchor?k=x" title="reCAPTCHA" width="256" height="60"></iframe></div>'),
    expect: { captcha: false, pass: true, wall: true } },

  { name: 'cloudflare-interstitial', path: '/', html: page('Just a moment...', '<h1>Checking your browser before accessing the site.</h1><p>This process is automatic. Just a moment...</p>'),
    expect: { captcha: true, wall: true } },

  { name: 'two-step-verification', path: '/signin/v2/challenge/ipp', html: page('2-Step Verification', '<h1>2-Step Verification</h1><p>Check your phone. Google sent a notification to your phone. Tap Yes on the notification to verify it\'s you.</p>'),
    expect: { user: false, pass: false, mfa: true, wall: true } },

  { name: 'logged-in-dashboard-stray-email-box', path: '/dashboard/team', html: page('Team settings - Acme', '<h1>Team</h1><input type="search" placeholder="Search members"><label>Invite teammate<input type="email" name="invitee" placeholder="name@company.com"></label><button>Send invite</button>'),
    expect: { pass: false, otp: false, captcha: false, mfa: false, wall: false }, note: 'user=true at probe level is fine: the engine only treats it as a login step on login-looking pages' },

  { name: 'logged-in-account-settings-mentions-security-keys', path: '/settings/security', html: page('Security - Acme', '<h1>Security</h1><p>Add a security key or authenticator app to protect your account. Text message codes are less secure.</p><input type="search" placeholder="Search settings">'),
    expect: { pass: false, otp: false, mfa: false, captcha: false, wall: false } },

  { name: 'public-docs', path: '/docs/getting-started', html: page('Getting started - Docs', '<h1>Getting started</h1><p>Install the CLI and sign in with your account when prompted.</p>'),
    expect: { user: false, pass: false, otp: false, captcha: false, mfa: false, wall: false } },

  { name: 'honeypot-only', path: '/home', html: page('Home', '<form><input type="password" name="trap" style="display:none"><input type="email" name="x" style="position:absolute;left:-9999px;width:0;height:0"></form><h1>Hello</h1>'),
    expect: { pass: false, wall: false } },

  { name: 'login-error-shown', path: '/login', html: page('Sign in', '<div role="alert">Incorrect email or password. Try again.</div><form><input type="email" name="email"><input type="password" name="password"><button type="submit">Sign in</button></form>'),
    expect: { error: true, pass: true, wall: true } },

  // ---- other languages ----
  { name: 'spanish-login', path: '/iniciar-sesion', html: page('Iniciar sesi&oacute;n', '<form><label>Correo electr&oacute;nico<input type="text" name="usuario" placeholder="Correo electr&oacute;nico"></label><label>Contrase&ntilde;a<input type="password" name="clave"></label><button type="submit">Iniciar sesi&oacute;n</button><button type="button">Crear cuenta</button></form>'),
    expect: { user: true, pass: true, wall: true, submit: 'click' } },

  { name: 'german-login', path: '/anmelden', html: page('Anmelden', '<form><label>E-Mail-Adresse<input type="text" name="benutzername"></label><label>Passwort<input type="password" name="passwort"></label><button type="submit">Anmelden</button><button type="button">Passwort vergessen?</button></form>'),
    expect: { user: true, pass: true, wall: true, submit: 'click' } },

  { name: 'french-login', path: '/connexion', html: page('Connexion', '<form><label>Identifiant<input type="text" name="identifiant"></label><label>Mot de passe<input type="password" name="mdp"></label><button type="submit">Se connecter</button><a href="#">Mot de passe oubli&eacute; ?</a></form>'),
    expect: { user: true, pass: true, wall: true, submit: 'click' } },

  { name: 'spanish-error', path: '/iniciar-sesion', html: page('Iniciar sesi&oacute;n', '<div role="alert">Contrase&ntilde;a incorrecta. Int&eacute;ntalo de nuevo.</div><form><input type="email" name="email"><input type="password" name="clave"><button type="submit">Iniciar sesi&oacute;n</button></form>'),
    expect: { error: true, wall: true } },

  { name: 'german-2fa', path: '/anmelden/verifizieren', html: page('Best&auml;tigung in zwei Schritten', '<h1>Best&auml;tigung in zwei Schritten</h1><p>Geben Sie den Best&auml;tigungscode ein, den wir Ihnen gesendet haben.</p><input name="code" type="text" inputmode="numeric" placeholder="Best&auml;tigungscode"><button type="submit">Weiter</button>'),
    expect: { otp: true, mfa: true, wall: true } },

  { name: 'spanish-captcha', path: '/verificar', html: page('Verificaci&oacute;n', '<h1>Verifica que eres humano</h1><label><input type="checkbox"> No soy un robot</label>'),
    expect: { captcha: true, wall: true } },

  { name: 'german-captcha', path: '/pruefung', html: page('Sicherheitspr&uuml;fung', '<h1>Ich bin kein Roboter</h1><p>Bitte best&auml;tigen Sie, dass Sie ein Mensch sind.</p>'),
    expect: { captcha: true, wall: true } },

  { name: 'portuguese-login', path: '/entrar', html: page('Entrar', '<form><label>E-mail<input type="email" name="email"></label><label>Senha<input type="password" name="senha"></label><button type="submit">Entrar</button></form>'),
    expect: { user: true, pass: true, wall: true } },

  // ---- documented limitation ----
  { name: 'shadow-dom-login-known-gap', path: '/login', html: page('Sign in', '<div id="host"></div><script>const r=document.getElementById("host").attachShadow({mode:"open"});r.innerHTML=\'<input type="email" name="email"><input type="password" name="password"><button>Sign in</button>\';</script>'),
    expect: { pass: false, wall: true }, note: 'inputs inside shadow DOM are not seen (fails safe: the page still counts as a login wall because of its URL/title, so a person is asked)' },
];
