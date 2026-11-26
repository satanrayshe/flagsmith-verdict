import { ApiResponse, Transport, parseBody } from './transport.js';

/** Calls the Admin API directly with an API key. The key is only ever sent as a header. */
export class HttpTransport implements Transport {
  readonly name = 'api-key';
  constructor(private apiKey: string, private baseUrl = 'https://api.flagsmith.com') {}

  async request(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const res = await fetch(`${this.baseUrl}/api/v1/${path}`, {
      method,
      headers: {
        Authorization: `Api-Key ${this.apiKey}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: parseBody(await res.text()) };
  }
}
