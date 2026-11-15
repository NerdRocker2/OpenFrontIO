/**
 * Track menu teardown independently of the in-game body class: prestart
 * stops the lobby list before join marks the game active. A leave during
 * that gap must still restore the lobby list and menu audio in Main.
 */
let tornDown = false;

export function menuChromeIsTornDown(): boolean {
  return tornDown;
}

export function hideMenuChrome(): void {
  tornDown = true;
}

export function restoreMenuChrome(): void {
  tornDown = false;
}
