import { Experiment, Exposures, FlagInfo, MetricInfo, Results, Warehouse } from '../model.js';
import {
  listOf, normalizeExperiment, normalizeExposures, normalizeFlag, normalizeMetric, normalizeResults, normalizeWarehouse,
} from './normalize.js';
import { ApiError, ApiResponse, Transport } from './transport.js';

export interface RefreshOutcome { requested: boolean; retryAfterSeconds?: number; status: number }

/** Typed calls against the Flagsmith Admin API for one environment. */
export class FlagsmithClient {
  /** Number of API requests made, for the request budget line in verbose output. */
  requests = 0;
  private projectIdCache: number | null = null;

  constructor(private transport: Transport, readonly environmentKey: string) {}

  get transportName(): string { return this.transport.name; }

  private async call(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    this.requests += 1;
    return this.transport.request(method, path, body);
  }

  private async get(path: string): Promise<any> {
    const r = await this.call('GET', path);
    if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, path.replace(this.environmentKey, '<environment>'), r.json);
    return r.json;
  }

  private env(path: string): string { return `environments/${this.environmentKey}/${path}`; }

  async projectId(): Promise<number> {
    if (this.projectIdCache === null) {
      const env = await this.get(`environments/${this.environmentKey}/`);
      this.projectIdCache = env.project;
    }
    return this.projectIdCache!;
  }

  async listExperiments(): Promise<Experiment[]> {
    return listOf(await this.get(this.env('experiments/?page_size=100'))).map(normalizeExperiment);
  }

  async getExperiment(id: number): Promise<Experiment> {
    return normalizeExperiment(await this.get(this.env(`experiments/${id}/`)));
  }

  /** Finds an experiment by id, exact name, case-insensitive name, or flag name. */
  async findExperiment(ref: string): Promise<Experiment> {
    const all = await this.listExperiments();
    const lower = ref.toLowerCase();
    const match =
      all.find((e) => String(e.id) === ref) ??
      all.find((e) => e.name === ref) ??
      all.find((e) => e.name.toLowerCase() === lower) ??
      // A flag can have had several experiments; prefer the one that is not finished.
      all.find((e) => e.flag.name === ref && e.status !== 'completed') ??
      all.find((e) => e.flag.name === ref);
    if (!match) {
      const names = all.map((e) => `"${e.name}" (${e.flag.name})`).join(', ') || 'none';
      throw new Error(`No experiment matches "${ref}". Experiments in this environment: ${names}.`);
    }
    return this.getExperiment(match.id);
  }

  async getExposures(id: number): Promise<Exposures | null> {
    return normalizeExposures(await this.get(this.env(`experiments/${id}/exposures/`)));
  }

  async getResults(id: number): Promise<Results | null> {
    return normalizeResults(await this.get(this.env(`experiments/${id}/results/`)));
  }

  private async refresh(path: string): Promise<RefreshOutcome> {
    const r = await this.call('POST', path);
    if (r.status === 429) {
      const m = JSON.stringify(r.json ?? '').match(/in (\d+) seconds/);
      return { requested: false, retryAfterSeconds: m ? Number(m[1]) : 300, status: 429 };
    }
    return { requested: r.status >= 200 && r.status < 300, status: r.status };
  }

  refreshResults(id: number): Promise<RefreshOutcome> { return this.refresh(this.env(`experiments/${id}/results/refresh/`)); }
  refreshExposures(id: number): Promise<RefreshOutcome> { return this.refresh(this.env(`experiments/${id}/exposures/refresh/`)); }

  async listMetrics(): Promise<MetricInfo[]> {
    return listOf(await this.get(this.env('experiment-metrics/?page_size=100'))).map(normalizeMetric);
  }

  async listWarehouses(): Promise<Warehouse[]> {
    return listOf(await this.get(this.env('warehouse-connections/'))).map(normalizeWarehouse);
  }

  /** Event names the warehouse has received. Null when the warehouse cannot list them. */
  async warehouseEvents(warehouseId: number): Promise<string[] | null> {
    const r = await this.call('GET', this.env(`warehouse-connections/${warehouseId}/events/`));
    if (r.status !== 200 || !Array.isArray(r.json?.events)) return null;
    return r.json.events;
  }

  async listFlags(): Promise<FlagInfo[]> {
    const project = await this.projectId();
    return listOf(await this.get(`projects/${project}/features/?page_size=999`)).map(normalizeFlag);
  }

  /** Ends the experiment and applies the rollout decision in one call. Returns the raw response. */
  completeExperiment(id: number, body: { rollout_decision: 'control' | 'variant' | 'disable'; rollout_variant?: number }): Promise<ApiResponse> {
    return this.call('POST', this.env(`experiments/${id}/complete/`), body);
  }

  dashboardUrl(projectId: number, experimentId: number): string {
    return `https://app.flagsmith.com/project/${projectId}/environment/${this.environmentKey}/experiments/${experimentId}`;
  }
}
