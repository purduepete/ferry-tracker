(() => {
  let preference = 'midnight';
  try {
    const stored = localStorage.getItem('ferry-tracker-theme');
    if (['system', 'light', 'midnight'].includes(stored)) preference = stored;
    else if (stored === 'dark') preference = 'midnight';
  } catch {}
  const theme = preference === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'midnight' : 'light')
    : preference;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.remove('light', 'dark', 'theme-midnight');
  root.classList.add(...(theme === 'light' ? ['light'] : ['dark', 'theme-midnight']));
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  const chrome = theme === 'light' ? '#ffffff' : '#0f172a';
  root.style.backgroundColor = chrome;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', chrome);
})();
