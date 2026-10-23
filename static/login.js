(() => {
  const form = document.querySelector('#loginForm');
  const button = document.querySelector('#loginButton');
  const error = document.querySelector('#loginError');
  const password = document.querySelector('#password');
  const spinner = document.querySelector('.submit-spinner');

  const showError = message => {
    error.textContent = message;
    error.hidden = false;
  };

  if (new URLSearchParams(location.search).has('expired')) {
    showError('Сессия завершилась. Войдите снова.');
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.getAttribute('aria-disabled') === 'true') return;

    error.hidden = true;
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
        showError(payload.detail || 'Не удалось войти. Проверьте логин и пароль.');
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
