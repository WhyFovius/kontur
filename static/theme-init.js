(() => {
  try {
    const saved = localStorage.getItem('churn-theme');
    const system = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = saved === 'dark' || saved === 'light' ? saved : system;
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
