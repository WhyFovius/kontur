(() => {
  const form = document.querySelector('#loginForm');
  const button = document.querySelector('#loginButton');
  const error = document.querySelector('#loginError');
  const password = document.querySelector('#password');
  const username = document.querySelector('#username');
  const spinner = document.querySelector('.submit-spinner');

  const showError = (message, invalidCredentials = false) => {
    error.textContent = message;
    error.hidden = false;
    [username, password].forEach(input => {
      if (invalidCredentials) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    });
  };

  if (new URLSearchParams(location.search).has('expired')) {
    showError('Сессия завершилась. Войдите снова.');
  }

  [username, password].forEach(input => input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    if (!username.hasAttribute('aria-invalid') && !password.hasAttribute('aria-invalid')) error.hidden = true;
  }));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.getAttribute('aria-disabled') === 'true') return;

    error.hidden = true;
    username.removeAttribute('aria-invalid');
    password.removeAttribute('aria-invalid');
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-busy', 'true');
    spinner.hidden = false;

    const formData = new FormData(form);
    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: formData.get('username'), password: formData.get('password') }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        showError(payload.detail || 'Не удалось войти. Проверьте логин и пароль.', true);
        password.focus();
        return;
      }
      location.replace('/');
    } catch {
      showError('Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.');
    } finally {
      button.removeAttribute('aria-disabled');
      button.removeAttribute('aria-busy');
      spinner.hidden = true;
    }
  });
})();
