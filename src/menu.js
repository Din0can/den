// Menu screen logic — handles login/register/guest UI + in-game register prompt

let onAuth = null; // callback: (authData) => void — triggers network.connect

const SESSION_KEY = 'den_session';

export function getSessionToken() {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}

export function setSessionToken(token) {
  try { localStorage.setItem(SESSION_KEY, token); } catch {}
}

export function clearSessionToken() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

export function initMenu(connectFn) {
  onAuth = connectFn;

  const overlay = document.getElementById('menu-overlay');
  const usernameInput = document.getElementById('menu-username');
  const passwordInput = document.getElementById('menu-password');
  const errorEl = document.getElementById('menu-error');
  const loadingEl = document.getElementById('menu-loading');
  const btnLogin = document.getElementById('btn-login');
  const btnRegister = document.getElementById('btn-register');
  const btnGuest = document.getElementById('btn-guest');

  function setError(msg) { errorEl.textContent = msg; }
  function setLoading(show) {
    loadingEl.style.display = show ? 'block' : 'none';
    btnLogin.disabled = show;
    btnRegister.disabled = show;
    btnGuest.disabled = show;
  }

  btnLogin.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) { setError('Enter username and password'); return; }
    setError('');
    setLoading(true);
    onAuth({ username, password, action: 'login' });
  });

  btnRegister.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) { setError('Enter username and password'); return; }
    setError('');
    setLoading(true);
    onAuth({ username, password, action: 'register' });
  });

  btnGuest.addEventListener('click', () => {
    setError('');
    setLoading(true);
    onAuth({ guest: true });
  });

  // Enter key submits login
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnLogin.click();
  });
  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') passwordInput.focus();
  });

  // Auto-login with session token
  const token = getSessionToken();
  if (token) {
    setLoading(true);
    onAuth({ sessionToken: token });
  } else {
    usernameInput.focus();
  }
}

export function showMenu() {
  const overlay = document.getElementById('menu-overlay');
  overlay.classList.remove('hidden');
  document.getElementById('menu-error').textContent = '';
  document.getElementById('menu-loading').style.display = 'none';
  const btns = overlay.querySelectorAll('button');
  btns.forEach(b => b.disabled = false);
  document.getElementById('menu-username').focus();
}

export function hideMenu() {
  document.getElementById('menu-overlay').classList.add('hidden');
}

export function showMenuError(msg) {
  document.getElementById('menu-error').textContent = msg;
  document.getElementById('menu-loading').style.display = 'none';
  const overlay = document.getElementById('menu-overlay');
  const btns = overlay.querySelectorAll('button');
  btns.forEach(b => b.disabled = false);
}

// --- In-game register prompt (for guests at save points) ---

let registerPromptCallback = null; // (username, password) => void
let dismissCallback = null;

export function showRegisterPrompt(onRegister, onDismiss) {
  const el = document.getElementById('register-prompt');
  const usernameInput = document.getElementById('reg-prompt-username');
  const passwordInput = document.getElementById('reg-prompt-password');
  const errorEl = document.getElementById('register-prompt-error');
  const btnConfirm = document.getElementById('btn-reg-confirm');
  const btnDismiss = document.getElementById('btn-reg-dismiss');

  errorEl.textContent = '';
  usernameInput.value = '';
  passwordInput.value = '';
  el.classList.add('show');
  usernameInput.focus();

  // Clean up old listeners
  const newConfirm = btnConfirm.cloneNode(true);
  btnConfirm.parentNode.replaceChild(newConfirm, btnConfirm);
  const newDismiss = btnDismiss.cloneNode(true);
  btnDismiss.parentNode.replaceChild(newDismiss, btnDismiss);

  newConfirm.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) { errorEl.textContent = 'Enter username and password'; return; }
    errorEl.textContent = '';
    onRegister(username, password);
  });

  newDismiss.addEventListener('click', () => {
    el.classList.remove('show');
    onDismiss?.();
  });

  // Escape dismisses
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      el.classList.remove('show');
      window.removeEventListener('keydown', escHandler);
      onDismiss?.();
    }
  };
  window.addEventListener('keydown', escHandler);
}

export function hideRegisterPrompt() {
  document.getElementById('register-prompt').classList.remove('show');
}

export function showRegisterPromptError(msg) {
  document.getElementById('register-prompt-error').textContent = msg;
}

// --- Death overlay ---

export function showDeathOverlay(message) {
  const el = document.getElementById('death-overlay');
  const sub = document.getElementById('death-sub');
  sub.textContent = message || 'returning to last save...';
  el.classList.remove('show');
  // Force reflow to restart animation
  void el.offsetWidth;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}
