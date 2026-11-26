export interface ApiResponse { status: number; json: any }

/** One request against the Flagsmith Admin API. `path` is relative to /api/v1/. */
export interface Transport {
  readonly name: string;
  request(method: string, path: string, body?: unknown): Promise<ApiResponse>;
}

export class ApiError extends Error {
  constructor(public status: number, public path: string, public detail: unknown) {
    super(`Flagsmith API ${status} on ${path}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 400));
  }
}

export function parseBody(text: string): any {
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return text; }
}
