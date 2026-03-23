// Menu screen logic - login/register/guest, color picker, in-game register prompt

let onAuth = null;
const SESSION_KEY = 'den_session';

// --- Color generation ---

const HUES = 16;
const SOLID_ROWS = [
  { sat: 100, lit: 50 },  // vibrant
  { sat: 80, lit: 60 },   // bright
  { sat: 60, lit: 75 },   // pastel
  { sat: 90, lit: 40 },   // deep
  { sat: 40, lit: 55 },   // muted
  { sat: 70, lit: 30 },   // dark
];

function generateSolidColors() {
  const colors = [];
  for (const row of SOLID_ROWS) {
    for (let i = 0; i < HUES; i++) {
      colors.push(`hsl(${Math.round(i * (360 / HUES))}, ${row.sat}%, ${row.lit}%)`);
    }
  }
  return colors;
}

function generateGradientColors() {
  const gradients = [];
  // Adjacent hue gradients
  for (let i = 0; i < HUES; i++) {
    const h1 = Math.round(i * (360 / HUES));
    const h2 = Math.round(((i + 3) % HUES) * (360 / HUES));
    gradients.push(`gradient:hsl(${h1}, 80%, 60%):hsl(${h2}, 80%, 60%)`);
  }
  // Complementary gradients
  for (let i = 0; i < HUES; i++) {
    const h1 = Math.round(i * (360 / HUES));
    const h2 = (h1 + 180) % 360;
    gradients.push(`gradient:hsl(${h1}, 90%, 55%):hsl(${h2}, 90%, 55%)`);
  }
  return gradients;
}

function parseGradientCSS(gradStr) {
  // 'gradient:hsl(...):hsl(...)' -> 'linear-gradient(to bottom, hsl(...), hsl(...))'
  const parts = gradStr.slice(9).split(':');
  // parts may contain hsl values with commas - need to rejoin properly
  // format: gradient:hsl(h, s%, l%):hsl(h, s%, l%)
  // split on ':' gives ['hsl(h, s%, l%)', 'hsl(h, s%, l%)']
  // but hsl has no colons so this is safe
  return `linear-gradient(to bottom, ${parts[0]}, ${parts[1]})`;
}

function createSwatch(color, onSelect) {
  const swatch = document.createElement('div');
  swatch.className = 'color-swatch';
  swatch.textContent = '@';

  if (color.startsWith('gradient:')) {
    swatch.classList.add('gradient-swatch');
    swatch.style.background = parseGradientCSS(color);
    swatch.style.webkitBackgroundClip = 'text';
    swatch.style.webkitTextFillColor = 'transparent';
    swatch.style.backgroundClip = 'text';
  } else {
    swatch.style.color = color;
  }

  swatch.addEventListener('click', () => onSelect(swatch, color));
  swatch.dataset.color = color;
  return swatch;
}

function populateColorPicker(container, previewEl, includeGradients, onColorChange) {
  container.innerHTML = '';
  let selected = null;

  function selectSwatch(swatch, color) {
    if (selected) selected.classList.remove('selected');
    swatch.classList.add('selected');
    selected = swatch;
    if (previewEl) {
      if (color.startsWith('gradient:')) {
        previewEl.style.background = parseGradientCSS(color);
        previewEl.style.webkitBackgroundClip = 'text';
        previewEl.style.webkitTextFillColor = 'transparent';
        previewEl.style.backgroundClip = 'text';
        previewEl.style.color = '';
      } else {
        previewEl.style.background = '';
        previewEl.style.webkitBackgroundClip = '';
        previewEl.style.webkitTextFillColor = '';
        previewEl.style.backgroundClip = '';
        previewEl.style.color = color;
      }
    }
    onColorChange(color);
  }

  // Solid colors
  const solids = generateSolidColors();
  for (const color of solids) {
    container.appendChild(createSwatch(color, selectSwatch));
  }

  if (includeGradients) {
    const label = document.createElement('div');
    label.className = 'gradient-section-label';
    label.textContent = 'Gradients';
    container.appendChild(label);

    const gradients = generateGradientColors();
    for (const color of gradients) {
      container.appendChild(createSwatch(color, selectSwatch));
    }
  }

  return {
    preselectColor(color) {
      const el = container.querySelector(`[data-color="${CSS.escape(color)}"]`);
      if (el) selectSwatch(el, color);
    }
  };
}

// --- Session ---

export function getSessionToken() {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}
export function setSessionToken(token) {
  try { localStorage.setItem(SESSION_KEY, token); } catch {}
}
export function clearSessionToken() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// --- Main menu ---

export function initMenu(connectFn) {
  onAuth = connectFn;

  // Privacy overlay
  const privacyLink = document.getElementById('privacy-link');
  const privacyOverlay = document.getElementById('privacy-overlay');
  const privacyClose = document.getElementById('privacy-close');
  if (privacyLink && privacyOverlay) {
    privacyLink.addEventListener('click', () => privacyOverlay.classList.add('show'));
    privacyClose?.addEventListener('click', () => privacyOverlay.classList.remove('show'));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && privacyOverlay.classList.contains('show')) {
        privacyOverlay.classList.remove('show');
      }
    });
  }

  const overlay = document.getElementById('menu-overlay');
  const usernameInput = document.getElementById('menu-username');
  const passwordInput = document.getElementById('menu-password');
  const errorEl = document.getElementById('menu-error');
  const loadingEl = document.getElementById('menu-loading');
  const btnLogin = document.getElementById('btn-login');
  const btnRegister = document.getElementById('btn-register');
  const btnGuest = document.getElementById('btn-guest');

  function setError(msg) { errorEl.textContent = msg; }
  function setStatus(msg) {
    loadingEl.textContent = msg;
    loadingEl.style.display = msg ? 'block' : 'none';
  }
  function setBusy(busy) {
    btnLogin.disabled = busy;
    btnRegister.disabled = busy;
    btnGuest.disabled = busy;
    usernameInput.disabled = busy;
    passwordInput.disabled = busy;
  }

  btnLogin.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username) { setError('Enter a username'); return; }
    if (!password) { setError('Enter a password'); return; }
    setError('');
    setStatus('Logging in...');
    setBusy(true);
    onAuth({ username, password, action: 'login' });
  });

  btnRegister.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username) { setError('Choose a username'); return; }
    if (!password) { setError('Choose a password'); return; }
    setError('');
    showColorPickerOverlay(username, password, true);
  });

  btnGuest.addEventListener('click', () => {
    setError('');
    showColorPickerOverlay(null, null, false);
  });

  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnLogin.click();
  });
  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') passwordInput.focus();
  });

  // --- Color picker overlay ---
  const pickerOverlay = document.getElementById('color-picker-overlay');
  const pickerPreview = document.getElementById('color-picker-preview');
  const pickerSwatches = document.getElementById('color-picker-swatches');
  const pickerError = document.getElementById('color-picker-error');
  const pickerTitle = document.getElementById('color-picker-title');
  const btnConfirm = document.getElementById('btn-color-confirm');
  const btnBack = document.getElementById('btn-color-back');

  let pendingUsername = '';
  let pendingPassword = '';
  let selectedColor = null;
  let isRegistration = false;

  btnConfirm.addEventListener('click', () => {
    if (!selectedColor) { pickerError.textContent = 'Pick a color first'; return; }
    pickerOverlay.classList.remove('show');
    if (isRegistration) {
      setStatus('Creating account...');
      setBusy(true);
      onAuth({ username: pendingUsername, password: pendingPassword, color: selectedColor, action: 'register' });
    } else {
      setStatus('Joining...');
      setBusy(true);
      onAuth({ guest: true, color: selectedColor });
    }
  });

  btnBack.addEventListener('click', () => {
    pickerOverlay.classList.remove('show');
  });

  function showColorPickerOverlay(username, password, forRegistration) {
    pendingUsername = username || '';
    pendingPassword = password || '';
    isRegistration = forRegistration;
    selectedColor = null;
    pickerPreview.style.color = '#888';
    pickerPreview.style.background = '';
    pickerPreview.style.webkitBackgroundClip = '';
    pickerPreview.style.webkitTextFillColor = '';
    pickerPreview.style.backgroundClip = '';
    pickerError.textContent = '';
    pickerTitle.textContent = 'Choose your color';
    populateColorPicker(pickerSwatches, pickerPreview, forRegistration, (color) => {
      selectedColor = color;
      pickerError.textContent = '';
    });
    pickerOverlay.classList.add('show');
  }

  // Auto-login with session token
  const token = getSessionToken();
  if (token) {
    setStatus('Reconnecting...');
    setBusy(true);
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
  overlay.querySelectorAll('button').forEach(b => b.disabled = false);
  overlay.querySelectorAll('input').forEach(i => i.disabled = false);
  document.getElementById('color-picker-overlay').classList.remove('show');
  document.getElementById('menu-username').focus();
}

export function hideMenu() {
  document.getElementById('menu-overlay').classList.add('hidden');
  document.getElementById('color-picker-overlay').classList.remove('show');
}

export function showMenuError(msg) {
  document.getElementById('menu-error').textContent = msg;
  document.getElementById('menu-loading').style.display = 'none';
  const overlay = document.getElementById('menu-overlay');
  overlay.querySelectorAll('button').forEach(b => b.disabled = false);
  overlay.querySelectorAll('input').forEach(i => i.disabled = false);
  document.getElementById('color-picker-overlay').classList.remove('show');
}

// --- In-game register prompt (full-screen, matches main menu style) ---

export function showRegisterPrompt(onRegister, onDismiss, currentGuestColor) {
  const el = document.getElementById('register-prompt');
  const usernameInput = document.getElementById('reg-prompt-username');
  const passwordInput = document.getElementById('reg-prompt-password');
  const errorEl = document.getElementById('register-prompt-error');
  const swatchContainer = document.getElementById('reg-prompt-swatches');
  const previewEl = document.getElementById('reg-prompt-preview');
  const btnConfirm = document.getElementById('btn-reg-confirm');
  const btnDismiss = document.getElementById('btn-reg-dismiss');

  errorEl.textContent = '';
  usernameInput.value = '';
  passwordInput.value = '';
  el.classList.add('show');

  let regSelectedColor = currentGuestColor || null;

  // Populate with solids + gradients (registration unlocks gradients)
  const picker = populateColorPicker(swatchContainer, previewEl, true, (color) => {
    regSelectedColor = color;
    errorEl.textContent = '';
  });

  // Pre-select the guest's current color if they have one
  if (currentGuestColor) {
    picker.preselectColor(currentGuestColor);
  }

  usernameInput.focus();

  // Clean up old listeners
  const newConfirm = btnConfirm.cloneNode(true);
  btnConfirm.parentNode.replaceChild(newConfirm, btnConfirm);
  const newDismiss = btnDismiss.cloneNode(true);
  btnDismiss.parentNode.replaceChild(newDismiss, btnDismiss);

  newConfirm.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username) { errorEl.textContent = 'Choose a username'; return; }
    if (!password) { errorEl.textContent = 'Choose a password'; return; }
    if (!regSelectedColor) { errorEl.textContent = 'Pick a color'; return; }
    errorEl.textContent = '';
    onRegister(username, password, regSelectedColor);
  });

  newDismiss.addEventListener('click', () => {
    el.classList.remove('show');
    onDismiss?.();
  });

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
  void el.offsetWidth;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}
