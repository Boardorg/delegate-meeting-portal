import { Attendee } from '@/types';

let cachedToken: string | null = null;

export async function authenticate(): Promise<string> {
  // TODO (Mark): Implement Salesforce OAuth 2.0 username-password flow using env vars.
  // Required env vars: SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET,
  // SALESFORCE_USERNAME, SALESFORCE_PASSWORD, SALESFORCE_SECURITY_TOKEN,
  // SALESFORCE_INSTANCE_URL
  if (cachedToken) return cachedToken;
  cachedToken = 'stub-access-token';
  return cachedToken;
}

export async function query(soql: string): Promise<unknown[]> {
  // TODO (Mark): Execute a SOQL query against the Salesforce REST API.
  // Use authenticate() to get the access token, then POST to
  // ${SALESFORCE_INSTANCE_URL}/services/data/${SALESFORCE_API_VERSION}/query?q=...
  void soql;
  return [];
}

export async function getAttendees(eventId: string): Promise<Attendee[]> {
  // TODO (Mark): Query the custom Attendee__c object filtered by eventId.
  void eventId;
  return [];
}
