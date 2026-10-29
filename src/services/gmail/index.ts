import { createGmailOAuthService, type GmailOAuthService } from './gmail-oauth';
import { createGmailApiService, type GmailApiService } from './gmail-api';

export { type GmailOAuthService } from './gmail-oauth';
export { type GmailApiService, type EmailMetadata, type EmailFull, type DraftResult, type SendResult } from './gmail-api';
export { GmailIntegrationProvider } from './gmail-provider';
export { createGmailTools } from './tools/gmail-tools';
export { GMAIL_SCOPES, DEFAULT_GMAIL_SCOPES, SEND_GMAIL_SCOPES } from './gmail-oauth';

let oauthService: GmailOAuthService | null = null;
let apiService: GmailApiService | null = null;

export function getGmailOAuth(): GmailOAuthService {
  if (!oauthService) oauthService = createGmailOAuthService();
  return oauthService;
}

export function getGmailApi(): GmailApiService {
  if (!apiService) apiService = createGmailApiService(getGmailOAuth());
  return apiService;
}

export function setGmailServicesForTesting(
  oauth: GmailOAuthService | null,
  api: GmailApiService | null,
): void {
  oauthService = oauth;
  apiService = api;
}
