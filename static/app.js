(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = {
    sort: 'score',
    order: 'desc',
    risk: '',
    offset: 0,
    pageSize: 50,
    customers: [],
    settings: null,
    summary: null,
    refreshPromise: null,
    pendingWeights: {},
    saveTimer: null,
    savePromise: null,
    toastTimer: null,
    observer: null,
    chartSignature: null,
  };
  const riskLabels = { high: 'Высокий', medium: 'Средний', low: 'Низкий', unrated: 'Нет оценки' };
  const serviceStatusLabels = {
    active: 'Активна', suspended: 'Приостановлена', prolong_wait: 'Ожидает оплаты', deleted: 'Удалена', blocked: 'Заблокирована',
  };
  const paymentLabels = { hour: 'почасово', week: 'еженедельно', month: 'ежемесячно', quarter_year: 'раз в три месяца', half_year: 'раз в полгода', year: 'ежегодно' };
  const money = cents => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format((Number(cents) || 0) / 100);
  const integer = value => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value) || 0);
  const customerWord = value => ({ one: 'клиент', few: 'клиента', many: 'клиентов', other: 'клиентов' })[new Intl.PluralRules('ru-RU').select(Number(value) || 0)];
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
    if (response.status === 401) {
      location.replace('/login?expired=1');
      throw new ApiError('Сессия завершилась. Войдите снова.', 401);
    }
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('json') ? await response.json().catch(() => ({})) : await response.text();
    if (!response.ok) {
      const message = typeof payload === 'object' ? payload.detail || `Ошибка ${response.status}` : payload || `Ошибка ${response.status}`;
      throw new ApiError(message, response.status);
    }
    return payload;
  }

  function showToast(message, { persistent = false } = {}) {
    const toast = $('#toast');
    $('#toastMessage').textContent = message;
    $('#toastClose').hidden = !persistent;
    toast.classList.add('show');
    clearTimeout(state.toastTimer);
    if (!persistent) state.toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
  }

  function setSaving(status, text) {
    const node = $('#saveStatus');
    node.className = `saved-status ${status || ''}`;
    $('#saveStatusText').textContent = text;
  }

  function withTransitionsSuppressed(change) {
    const root = document.documentElement;
    root.classList.add('theme-switching');
    change();
    void root.offsetHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  }

  function applyTheme(theme, persist = true) {
    const isDark = theme === 'dark';
    withTransitionsSuppressed(() => { document.documentElement.dataset.theme = isDark ? 'dark' : 'light'; });
    const toggle = $('#themeToggle');
    toggle.setAttribute('aria-pressed', String(isDark));
    toggle.setAttribute('aria-label', `Переключить на ${isDark ? 'светлую' : 'тёмную'} тему`);
    toggle.title = `Переключить на ${isDark ? 'светлую' : 'тёмную'} тему`;
    if (persist) {
      try { localStorage.setItem('churn-theme', isDark ? 'dark' : 'light'); } catch { /* Storage may be unavailable in private contexts. */ }
    }
    if (state.summary) updateDonut(state.summary);
  }

  function setAnimatedText(selector, value) {
    const node = $(selector);
    const next = String(value);
    if (node.textContent === next) return;
    node.textContent = next;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    node.classList.remove('value-update');
    requestAnimationFrame(() => {
      node.classList.add('value-update');
      setTimeout(() => node.classList.remove('value-update'), 320);
    });
  }

  function updateDonut(data) {
    const levels = [data.highRisk, data.mediumRisk, data.lowRisk, data.unratedCount];
    const total = levels.reduce((sum, value) => sum + value, 0);
    setAnimatedText('#donutTotal', integer(total));
    ['#legendHigh', '#legendMedium', '#legendLow', '#legendUnrated'].forEach((selector, index) => { $(selector).textContent = integer(levels[index]); });
    const styles = getComputedStyle(document.documentElement);
    const colors = ['--md-risk-high-accent', '--md-risk-medium-accent', '--md-risk-low-accent', '--md-risk-unrated-accent']
      .map(token => styles.getPropertyValue(token).trim() || styles.getPropertyValue(token.replace('-accent', '')).trim());
    let angle = 0;
    const segments = levels.map((value, index) => {
      const start = angle;
      angle += total ? (value / total) * 360 : 360;
      return `${colors[index]} ${start}deg ${angle}deg`;
    });
    $('#riskDonut').style.background = `conic-gradient(${segments.join(',')})`;
  }

  function updateChart(forecast) {
    const counts = forecast?.counts || [0, 0, 0, 0, 0];
    const signature = counts.join(',');
    const maxValue = Math.max(4, ...counts);
    const axisMax = Math.ceil(maxValue / 4) * 4;
    const axisSteps = [axisMax, axisMax * .75, axisMax * .5, axisMax * .25, 0];
    $$('.chart-axis span').forEach((label, index) => { label.textContent = integer(axisSteps[index]); });
    const x = index => index * 200;
    const y = value => 170 - (value / axisMax) * 158;
    const points = counts.map((value, index) => `${x(index)},${y(value)}`);
    const current = counts[0] || 0;
    $('#chartFact').setAttribute('d', `M 0 ${y(current)} L 24 ${y(current)}`);
    $('#chartForecast').setAttribute('d', `M 24 ${y(current)} ${points.slice(1).map(point => `L ${point}`).join(' ')}`);
    $('#chartArea').setAttribute('d', `M 24 180 L 24 ${y(current)} ${points.slice(1).map(point => `L ${point}`).join(' ')} L 800 180 Z`);
    $('#chartStart').setAttribute('cx', '0');
    $('#chartStart').setAttribute('cy', String(y(current)));
    $('#chartEnd').setAttribute('cx', String(x(4)));
    $('#chartEnd').setAttribute('cy', String(y(counts[4] || 0)));
    $('#trendChart').setAttribute('aria-label', `Сейчас ${integer(current)} услуг на продлении; к сроку 30 дней ожидается ${integer(counts[4] || 0)} услуг.`);
    if (state.chartSignature !== null && state.chartSignature !== signature) {
      const plot = $('.chart-plot');
      plot.classList.remove('is-updating');
      requestAnimationFrame(() => {
        plot.classList.add('is-updating');
        setTimeout(() => plot.classList.remove('is-updating'), 320);
      });
    }
    state.chartSignature = signature;
  }

  function renderSummary(data) {
    const previous = state.summary;
    setAnimatedText('#metricCustomers', integer(data.customerCount));
    setAnimatedText('#metricRated', integer(data.ratedCount));
    setAnimatedText('#metricRatedPercent', `${data.customerCount ? Math.round((data.ratedCount / data.customerCount) * 100) : 0}%`);
    setAnimatedText('#metricHigh', integer(data.highRisk));
    setAnimatedText('#metricLoss', money(data.estimatedLoss));
    setAnimatedText('#lossHero', money(data.estimatedLoss));
    setAnimatedText('#metricServices', integer(data.atRiskServices));
    setAnimatedText('#revenueAtRisk', money(data.monthlyRevenueAtRisk));
    setAnimatedText('#navCount', integer(data.customerCount));
    if (previous && ['customerCount', 'highRisk', 'mediumRisk', 'lowRisk', 'estimatedLoss', 'atRiskServices'].some(key => previous[key] !== data[key])) {
      $('#liveUpdates').textContent = `Данные обновлены. Клиентов: ${integer(data.customerCount)}; высокий риск: ${integer(data.highRisk)}; потенциальные потери: ${money(data.estimatedLoss)}.`;
    }
    state.summary = data;
    updateDonut(data);
    updateChart(data.churnForecast);
  }

  function customerSignature(items) {
    return JSON.stringify(items.map(customer => [
      customer.id, customer.email, customer.balance, customer.availableBalance, customer.totalReplenished,
      customer.score, customer.riskLevel, customer.reasons, customer.estimatedLoss, customer.services,
    ]));
  }

  function renderCustomers(result) {
    state.customers = result.items;
    $('#tableCount').textContent = `${integer(result.total)} ${customerWord(result.total)}`;
    const first = result.total ? state.offset + 1 : 0;
    const last = Math.min(state.offset + result.items.length, result.total);
    $('#pagePosition').textContent = `${integer(first)}–${integer(last)} из ${integer(result.total)}`;
    $('#pagePrevious').disabled = state.offset === 0;
    $('#pageNext').disabled = state.offset + result.items.length >= result.total;
    const body = $('#customerRows');
    const signature = customerSignature(result.items);
    if (body.dataset.signature === signature) return;
    body.dataset.signature = signature;
    if (!result.items.length) {
      body.innerHTML = '<tr><td colspan="7" class="loading-cell">Для выбранного фильтра клиентов нет</td></tr>';
      return;
    }
    body.innerHTML = result.items.map(customer => {
      const level = customer.riskLevel || 'unrated';
      const reasons = customer.reasons?.join(' · ') || 'Нет данных';
      const email = customer.email || '—';
      return `<tr>
        <td class="customer-id">#${escapeHTML(customer.id)}</td>
        <td><button class="customer-link" data-customer="${escapeHTML(customer.id)}" title="${escapeHTML(email)}">${escapeHTML(email)}</button><span class="customer-email">${customer.score == null ? 'Недостаточно данных для оценки' : `Риск ${riskLabels[level].toLowerCase()}`}</span></td>
        <td class="money-cell">${money(customer.balance)}</td>
        <td class="money-cell">${money(customer.totalReplenished)}</td>
        <td class="reason-cell" title="${escapeHTML(reasons)}">${escapeHTML(reasons)}</td>
        <td><span class="risk-pill ${level}">${customer.score == null ? 'Нет оценки' : `${riskLabels[level]} · ${customer.score} / 100`}</span></td>
        <td><button class="details-button" type="button" data-customer="${escapeHTML(customer.id)}" aria-label="Открыть карточку клиента ${escapeHTML(email)}">›</button></td>
      </tr>`;
    }).join('');
  }

  function renderWeights(settings) {
    state.settings = settings;
    const controls = $('#weightControls');
    controls.innerHTML = Object.entries(settings.weights).map(([key, value]) => {
      const label = settings.features[key] || key;
      const safeKey = escapeHTML(key);
      return `<div class="weight-item">
        <div class="weight-track">
          <div class="weight-label"><label for="weight-${safeKey}" id="weight-label-${safeKey}">${escapeHTML(label)}</label><span class="weight-live-value">${integer(value)}</span></div>
          <input class="weight-slider" id="weight-${safeKey}" type="range" min="0" max="100" step="1" value="${value}" data-weight="${safeKey}" aria-labelledby="weight-label-${safeKey}" aria-valuetext="${value} из 100">
        </div>
        <input class="weight-number" type="number" min="0" max="100" step="1" value="${value}" data-weight="${safeKey}" aria-label="Вес признака ${escapeHTML(label)}" inputmode="numeric">
      </div>`;
    }).join('');
    const thresholds = settings.thresholds || {};
    const medium = Number(thresholds.medium ?? 35);
    const high = Number(thresholds.high ?? 65);
    $('.threshold-note').innerHTML = `<b>Низкий</b> 0–${medium - 1} <i></i><b>Средний</b> ${medium}–${high - 1} <i></i><b>Высокий</b> ${high}–100`;
  }

  function scheduleWeightSave(key, value) {
    state.pendingWeights[key] = value;
    const controls = $('#weightControls');
    $$('[data-weight]', controls).forEach(input => {
      if (input.dataset.weight === key) input.value = String(value);
    });
    const row = $(`#weight-label-${CSS.escape(key)}`)?.closest('.weight-track');
    if (row) {
      $('.weight-live-value', row).textContent = integer(value);
      $(`#weight-${CSS.escape(key)}`)?.setAttribute('aria-valuetext', `${value} из 100`);
    }
    setSaving('saving', 'Сохраняем…');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushWeightSaves, 320);
  }

  async function flushWeightSaves() {
    if (state.savePromise || Object.keys(state.pendingWeights).length === 0) return;
    const changes = state.pendingWeights;
    state.pendingWeights = {};
    state.savePromise = (async () => {
      try {
        const updated = await api('/api/v1/model/settings', { method: 'PATCH', body: JSON.stringify({ weights: changes }) });
        state.settings = updated;
        setSaving('', 'Синхронизировано');
        await refresh(false);
      } catch (error) {
        setSaving('error', 'Не сохранено');
        showToast(`Не удалось сохранить коэффициент: ${error.message}`, { persistent: true });
      } finally {
        state.savePromise = null;
        if (Object.keys(state.pendingWeights).length > 0) flushWeightSaves();
      }
    })();
    await state.savePromise;
  }

  function renderCustomerDetail(customer) {
    const level = customer.riskLevel || 'unrated';
    $('#dialogTitle').textContent = customer.email || `Клиент #${customer.id}`;
    const statistics = [
      ['Риск-скор', customer.score == null ? 'Нет оценки' : `${customer.score} / 100`],
      ['Уровень риска', riskLabels[level]],
      ['Потенциальные потери за 90 дней', money(customer.estimatedLoss)],
      ['Баланс', money(customer.balance)],
      ['Доступно для продления', money(customer.availableBalance ?? customer.balance)],
      ['Пополнено за всё время', money(customer.totalReplenished)],
      ['Выручка в месяц', money(customer.monthlyRevenue)],
    ];
    const statMarkup = statistics.map(([label, value]) => `<div class="detail-stat"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`).join('');
    const reasons = (customer.reasons || []).map(reason => `<div class="reason-item">${escapeHTML(reason)}</div>`).join('') || '<p class="empty-detail">Срабатываний нет или данных недостаточно.</p>';
    const services = customer.services?.length ? customer.services.map(service => {
      const status = serviceStatusLabels[service.status] || service.status;
      const term = paymentLabels[service.paymentTerm] || service.paymentTerm || '—';
      const expiry = service.expiresAt ? new Date(service.expiresAt).toLocaleDateString('ru-RU') : '';
      return `<div class="service-row"><span>${escapeHTML(service.name || 'Услуга')} · ${money(service.price)}</span><span>${escapeHTML(status)} · ${escapeHTML(term)}${expiry ? ` · до ${escapeHTML(expiry)}` : ''}</span></div>`;
    }).join('') : '<p class="empty-detail">Услуги не загружены.</p>';
    const score = customer.score == null ? 0 : Math.max(0, Math.min(100, Number(customer.score)));
    const paymentsNote = customer.features?.failed_transactions
      ? '<p class="detail-data-note">В снимке есть сигнал о незавершённых платежах. Список отдельных транзакций API не предоставляет.</p>'
      : '<p class="detail-data-note">Отдельные транзакции не входят в данные карточки; показаны доступные суммы пополнений и услуг.</p>';
    $('#customerDetail').innerHTML = `<section class="detail-score ${level}" aria-label="Оценка риска ${customer.score == null ? 'недоступна' : `${score} из 100`}">
        <div class="detail-score-copy"><span>ОЦЕНКА РИСКА</span><strong>${customer.score == null ? '—' : `${score}<small> / 100</small>`}</strong></div>
        <span class="risk-pill ${level}">${riskLabels[level]}</span>
        <progress class="detail-score-track" max="100" value="${score}" aria-label="Шкала риска: ${customer.score == null ? 'нет оценки' : `${score} из 100`}"></progress>
      </section><div class="detail-stats">${statMarkup}</div>
      <section class="detail-section"><h3>Что повлияло на оценку</h3><div class="reason-list">${reasons}</div></section>
      <section class="detail-section"><h3>Услуги клиента</h3>${services}</section>${paymentsNote}
      <p class="empty-detail">Потери — оценка выручки активных услуг за три месяца после вычета доступного баланса, умноженная на долю риска. Это сценарная оценка для приоритизации контакта.</p>`;
  }

  async function openCustomer(id) {
    try {
      const customer = await api(`/api/v1/customers/${encodeURIComponent(id)}`);
      $$('#customerRows tr').forEach(row => row.classList.toggle('is-selected', Boolean(row.querySelector(`[data-customer="${CSS.escape(String(id))}"]`))));
      renderCustomerDetail(customer);
      $('#customerDialog').showModal();
    } catch (error) {
      if (error.status !== 401) showToast(`Не удалось открыть карточку: ${error.message}`, { persistent: true });
    }
  }

  async function refresh(includeSettings = false) {
    if (state.refreshPromise) {
      await state.refreshPromise;
      if (includeSettings) return refresh(true);
      return;
    }
    state.refreshPromise = (async () => {
      const params = new URLSearchParams({ sort: state.sort, order: state.order, limit: String(state.pageSize), offset: String(state.offset) });
      if (state.risk) params.set('risk', state.risk);
      const requests = [api('/api/v1/analytics/summary'), api(`/api/v1/customers?${params}`)];
      if (includeSettings) requests.push(api('/api/v1/model/settings'));
      const [summaryData, receivedCustomers, settings] = await Promise.all(requests);
      let customerData = receivedCustomers;
      if (state.offset > 0 && state.offset >= customerData.total) {
        state.offset = customerData.total ? Math.floor((customerData.total - 1) / state.pageSize) * state.pageSize : 0;
        params.set('offset', String(state.offset));
        customerData = await api(`/api/v1/customers?${params}`);
      }
      renderSummary(summaryData);
      renderCustomers(customerData);
      if (settings) renderWeights(settings);
      $('#lastUpdated').textContent = `Обновлено ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
      $('#connectionStatus').classList.remove('is-error');
      $('#connectionLabel').textContent = 'Синхронизация активна';
      $('#snapshotFreshness').textContent = 'Снимок синхронизирован';
      $('#snapshotSyncHint').textContent = 'Проверка каждые 10 сек.';
      document.body.classList.add('dashboard-ready');
      $('#tableFooter').textContent = `Оценка по текущему снимку · горизонт потерь — три месяца`;
    })();
    try {
      await state.refreshPromise;
    } finally {
      state.refreshPromise = null;
    }
  }

  function markConnectionError(error) {
    const status = $('#connectionStatus');
    status.classList.add('is-error');
    $('#connectionLabel').textContent = 'Нет связи с сервером';
    $('#snapshotFreshness').textContent = 'Сервер недоступен';
    $('#snapshotSyncHint').textContent = state.summary ? 'Показаны последние загруженные данные.' : 'Повторите загрузку, когда связь восстановится.';
    if (!state.summary) {
      $('#customerRows').innerHTML = `<tr><td colspan="7"><div class="table-state"><strong>Не удалось загрузить данные</strong><span>${escapeHTML(error.message)}</span><button class="table-retry" type="button" data-retry>Повторить</button></div></td></tr>`;
    }
  }

  function setActiveSection(section) {
    $$('.nav-item[data-section]').forEach(link => {
      const active = link.dataset.section === section;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }

  function configureNavigation() {
    const links = $$('.nav-item[data-section]');
    links.forEach(link => link.addEventListener('click', () => setActiveSection(link.dataset.section)));
    if (!('IntersectionObserver' in window)) return;
    state.observer = new IntersectionObserver(entries => {
      const nearest = entries.filter(entry => entry.isIntersecting).sort((a, b) => {
        return Math.abs(a.boundingClientRect.top - 110) - Math.abs(b.boundingClientRect.top - 110);
      })[0];
      if (nearest) setActiveSection(nearest.target.id);
    }, { rootMargin: '-12% 0px -35% 0px', threshold: [0, .1, .35] });
    $$('[data-observe-section]').forEach(section => state.observer.observe(section));
  }

  async function uploadSnapshot(file) {
    if (file.size > 32 * 1024 * 1024) {
      showToast('Файл больше допустимого размера 32 МБ.', { persistent: true });
      return;
    }
    const button = $('#uploadButton');
    const label = $('#uploadLabel');
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    label.textContent = 'Загружаем…';
    try {
      const contents = JSON.parse(await file.text());
      const accounts = contents.accounts ?? contents.users;
      if (Array.isArray(accounts) && accounts.length === 0 && !window.confirm('В снимке нет аккаунтов. Заменить текущие данные пустым снимком?')) return;
      const result = await api('/api/v1/source/snapshot', { method: 'PUT', body: JSON.stringify(contents) });
      showToast(`Снимок загружен · ${integer(result.accountCount)} аккаунтов`);
      await refresh(true);
    } catch (error) {
      showToast(`Не удалось загрузить снимок: ${error.message}`, { persistent: true });
    } finally {
      button.removeAttribute('aria-busy');
      button.disabled = false;
      label.textContent = 'Загрузить снимок';
      $('#snapshotFile').value = '';
    }
  }

  function bindControls() {
    const initialSort = $(`[data-sort="${state.sort}"]`);
    initialSort?.closest('th').setAttribute('aria-sort', 'descending');
    if (initialSort) initialSort.querySelector('span').textContent = '↓';
    $('#themeToggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    $('#riskFilter').addEventListener('change', event => {
      state.risk = event.target.value;
      event.target.classList.toggle('is-filtered', Boolean(state.risk));
      state.offset = 0;
      refresh().catch(error => showToast(`Не удалось отфильтровать клиентов: ${error.message}`, { persistent: true }));
    });
    $$('.sort-button').forEach(button => button.addEventListener('click', () => {
      if (state.sort === button.dataset.sort) state.order = state.order === 'asc' ? 'desc' : 'asc';
      else { state.sort = button.dataset.sort; state.order = 'desc'; }
      state.offset = 0;
      $$('.sort-button').forEach(item => item.closest('th').removeAttribute('aria-sort'));
      button.closest('th').setAttribute('aria-sort', state.order === 'asc' ? 'ascending' : 'descending');
      $$('.sort-button span').forEach(icon => { icon.textContent = '↕'; });
      button.querySelector('span').textContent = state.order === 'asc' ? '↑' : '↓';
      refresh().catch(error => showToast(`Не удалось отсортировать клиентов: ${error.message}`, { persistent: true }));
    }));
    $('#pagePrevious').addEventListener('click', () => {
      state.offset = Math.max(0, state.offset - state.pageSize);
      refresh().catch(error => showToast(`Не удалось открыть страницу клиентов: ${error.message}`, { persistent: true }));
    });
    $('#pageNext').addEventListener('click', () => {
      state.offset += state.pageSize;
      refresh().catch(error => showToast(`Не удалось открыть страницу клиентов: ${error.message}`, { persistent: true }));
    });
    $('#customerRows').addEventListener('click', event => {
      if (event.target.closest('[data-retry]')) {
        refresh(true).catch(error => { markConnectionError(error); showToast(`Не удалось загрузить данные: ${error.message}`, { persistent: true }); });
        return;
      }
      const button = event.target.closest('[data-customer]');
      if (button) openCustomer(button.dataset.customer);
    });
    $('#weightControls').addEventListener('input', event => {
      const input = event.target.closest('[data-weight]');
      if (!input || (input.type === 'number' && !input.validity.valid) || input.value === '') return;
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) return;
      scheduleWeightSave(input.dataset.weight, Math.round(value));
    });
    $('#weightControls').addEventListener('change', event => {
      const input = event.target.closest('input[type="number"][data-weight]');
      if (!input || input.validity.valid) return;
      input.value = String(state.settings?.weights[input.dataset.weight] ?? 0);
    });
    $('#uploadButton').addEventListener('click', () => $('#snapshotFile').click());
    $('#snapshotFile').addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (file) uploadSnapshot(file);
    });
    const logout = async () => {
      try {
        await api('/api/v1/auth/logout', { method: 'POST' });
      } catch (error) {
        if (error.status !== 401) showToast(`Не удалось завершить сессию: ${error.message}`, { persistent: true });
      } finally {
        location.replace('/login');
      }
    };
    $('#logoutButton').addEventListener('click', logout);
    $('#logoutButtonMobile').addEventListener('click', logout);
    $('.close-dialog').addEventListener('click', () => $('#customerDialog').close());
    $('#customerDialog').addEventListener('close', () => $$('#customerRows tr.is-selected').forEach(row => row.classList.remove('is-selected')));
    $('#customerDialog').addEventListener('click', event => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    });
    $('#toastClose').addEventListener('click', () => $('#toast').classList.remove('show'));
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
      try {
        if (!localStorage.getItem('churn-theme')) applyTheme(event.matches ? 'dark' : 'light', false);
      } catch { /* Keep the current theme when Storage is unavailable. */ }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh().catch(() => {});
    });
  }

  async function start() {
    applyTheme(document.documentElement.dataset.theme || 'light', false);
    configureNavigation();
    bindControls();
    try {
      const user = await api('/api/v1/auth/me');
      $('#userName').textContent = user.username;
      $('#todayLabel').textContent = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
      await refresh(true);
      window.setInterval(() => {
        if (document.visibilityState === 'visible' && !state.refreshPromise) {
          refresh().catch(error => { markConnectionError(error); showToast(`Не удалось обновить данные: ${error.message}`, { persistent: true }); });
        }
      }, 10000);
    } catch (error) {
      if (error.status !== 401) {
        console.error(error);
        markConnectionError(error);
        showToast(`Не удалось загрузить рабочее пространство: ${error.message}`, { persistent: true });
      }
    }
  }

  start();
})();
