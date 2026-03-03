const TOKEN_KEY = 'ccm_api_token';

export function getApiToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setApiToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearApiToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getApiToken();
}
