/** Full-page navigation behind a function so pages can be tested without touching window.location. */
export function navigateTo(url: string): void {
  window.location.href = url;
}
