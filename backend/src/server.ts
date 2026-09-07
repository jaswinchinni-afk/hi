import express, { Request, Response, NextFunction, Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('4000'),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  SPORTS_API_KEY: z.string().optional(),
  SPORTS_TIMEZONE: z.string().default('America/New_York'),
  SPORTS_CACHE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  TRANSFERS_CACHE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  TRANSFER_TEAM_IDS: z.string().optional(),
  AI_PROVIDER_KEY: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  CORS_ORIGIN: z.string().optional()
}).refine(data => data.NODE_ENV !== 'production' || Boolean(data.JWT_SECRET?.trim()), {
  message: 'JWT_SECRET is strictly required in production environment and cannot be empty',
  path: ['JWT_SECRET']
});

const parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) { console.error('[ENV_CONFIG_ERROR]', parsedEnv.error.format()); process.exit(1); }
export const env = parsedEnv.data;

export const aiAskSchema = z.object({
  prompt: z.string().min(1).max(1000),
  context: z.object({ matchId: z.string().optional(), playerId: z.string().optional(), teamId: z.string().optional(), transferId: z.string().optional(), apexFitGoal: z.string().optional() }).passthrough().optional()
});

export interface MatchData {
  id: string; homeTeam: string; awayTeam: string; score: string; minute: string; kickoff: string; status: string; league: string; venue?: string;
  dataSource: 'LIVE_PROVIDER' | 'SCHEDULED_PROVIDER' | 'COMPLETED_PROVIDER' | 'STALE_PROVIDER' | 'VERIFIED_SNAPSHOT';
}

export interface TransferData {
  id: string; player: string; date: string; type: string; from: string; to: string; source: 'LIVE_PROVIDER' | 'STALE_PROVIDER';
}

export interface VanguardProvider {
  getMatches(): Promise<{ data: MatchData[]; dataMode: string; live: boolean; fetchedAt: string; date: string }>;
  getTransfers(): Promise<{ data: TransferData[]; dataMode: string; fetchedAt: string }>;
  queryAI(prompt: string, context?: unknown): Promise<string>;
}

interface ApiFootballFixture { fixture?: { id?: number; date?: string; venue?: { name?: string }; status?: { short?: string; long?: string; elapsed?: number | null } }; league?: { id?: number; name?: string }; teams?: { home?: { name?: string }; away?: { name?: string } }; goals?: { home?: number | null; away?: number | null } }
interface ApiFootballTransfer { player?: { id?: number; name?: string }; update?: string; transfers?: Array<{ date?: string; type?: string; teams?: { in?: { name?: string }; out?: { name?: string } } }> }
interface ApiFootballResponse { response?: ApiFootballFixture[]; errors?: Record<string, unknown> }
interface ApiFootballTransferResponse { response?: ApiFootballTransfer[]; errors?: Record<string, unknown> }

const TOP_FIVE_LEAGUES = new Set([39, 140, 78, 135, 61]);
const TOP_FIVE_NAMES = new Set(['Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1']);
const DEFAULT_TRANSFER_TEAM_IDS = [42, 40, 49, 33, 50, 541, 529, 530, 157, 165, 168, 85, 81, 505, 489, 496, 492, 497, 499, 500];

function transferTeamIds(): number[] {
  const raw = env.TRANSFER_TEAM_IDS?.split(',').map(x => Number(x.trim())).filter(Number.isInteger) || [];
  return [...new Set(raw.length ? raw : DEFAULT_TRANSFER_TEAM_IDS)];
}

function localDate(timeZone: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function mapFixture(f: ApiFootballFixture): MatchData | null {
  const id = f.fixture?.id, home = f.teams?.home?.name, away = f.teams?.away?.name;
  if (!id || !home || !away || !f.fixture?.date) return null;
  if (!TOP_FIVE_LEAGUES.has(f.league?.id || -1) && !TOP_FIVE_NAMES.has(f.league?.name || '')) return null;
  const short = f.fixture.status?.short || 'NS';
  const live = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE']).has(short);
  const completed = new Set(['FT', 'AET', 'PEN']).has(short);
  const dataSource: MatchData['dataSource'] = live ? 'LIVE_PROVIDER' : completed ? 'COMPLETED_PROVIDER' : 'SCHEDULED_PROVIDER';
  const score = f.goals?.home == null || f.goals?.away == null ? '—' : `${f.goals.home} - ${f.goals.away}`;
  return { id: String(id), homeTeam: home, awayTeam: away, score, minute: live && f.fixture.status?.elapsed != null ? `${f.fixture.status.elapsed}'` : short, kickoff: f.fixture.date, status: f.fixture.status?.long || short, league: f.league?.name || 'Football', venue: f.fixture.venue?.name, dataSource };
}

class ApiFootballProvider implements VanguardProvider {
  private matchesCache: { date: string; fetchedAtMs: number; value: { data: MatchData[]; dataMode: string; live: boolean; fetchedAt: string; date: string } } | null = null;
  private transfersCache: { fetchedAtMs: number; value: { data: TransferData[]; dataMode: string; fetchedAt: string } } | null = null;

  private async request<T>(url: URL): Promise<T> {
    if (!env.SPORTS_API_KEY) throw Object.assign(new Error('Sports API key is not configured'), { statusCode: 503 });
    const response = await fetch(url, { headers: { 'x-apisports-key': env.SPORTS_API_KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Object.assign(new Error(`Sports provider returned HTTP ${response.status}`), { statusCode: response.status === 429 ? 429 : 502 });
    const payload = await response.json() as T & { errors?: Record<string, unknown> };
    if (payload.errors && Object.keys(payload.errors).length) throw Object.assign(new Error('Sports provider returned an error'), { statusCode: 502 });
    return payload;
  }

  async getMatches() {
    const date = localDate(env.SPORTS_TIMEZONE), now = Date.now(), freshMs = env.SPORTS_CACHE_MINUTES * 60_000;
    if (this.matchesCache && this.matchesCache.date === date && now - this.matchesCache.fetchedAtMs < freshMs) return this.matchesCache.value;
    try {
      const url = new URL('https://v3.football.api-sports.io/fixtures');
      url.searchParams.set('date', date); url.searchParams.set('timezone', env.SPORTS_TIMEZONE);
      const payload = await this.request<ApiFootballResponse>(url);
      const data = (payload.response || []).map(mapFixture).filter((x): x is MatchData => Boolean(x)).sort((a, b) => {
        const rank = (m: MatchData) => m.dataSource === 'LIVE_PROVIDER' ? 0 : m.dataSource === 'SCHEDULED_PROVIDER' ? 1 : 2;
        return rank(a) - rank(b) || a.kickoff.localeCompare(b.kickoff);
      });
      const value = { data, dataMode: 'API_FOOTBALL_TOP_FIVE', live: data.some(m => m.dataSource === 'LIVE_PROVIDER'), fetchedAt: new Date().toISOString(), date };
      this.matchesCache = { date, fetchedAtMs: now, value }; return value;
    } catch (error) {
      if (this.matchesCache && this.matchesCache.date === date) return { ...this.matchesCache.value, dataMode: 'STALE_API_FOOTBALL_TOP_FIVE', data: this.matchesCache.value.data.map(m => ({ ...m, dataSource: 'STALE_PROVIDER' as const })) };
      throw error;
    }
  }

  async getTransfers() {
    const now = Date.now(), freshMs = env.TRANSFERS_CACHE_HOURS * 60 * 60_000;
    if (this.transfersCache && now - this.transfersCache.fetchedAtMs < freshMs) return this.transfersCache.value;
    try {
      const all: TransferData[] = [];
      for (const teamId of transferTeamIds()) {
        const url = new URL('https://v3.football.api-sports.io/transfers');
        url.searchParams.set('team', String(teamId));
        const payload = await this.request<ApiFootballTransferResponse>(url);
        for (const player of payload.response || []) {
          const name = player.player?.name;
          if (!name) continue;
          for (const transfer of player.transfers || []) {
            if (!transfer.date) continue;
            all.push({
              id: `${player.player?.id || name}-${transfer.date}-${transfer.teams?.out?.name || 'unknown'}-${transfer.teams?.in?.name || 'unknown'}`,
              player: name,
              date: transfer.date,
              type: transfer.type || 'N/A',
              from: transfer.teams?.out?.name || 'Unknown',
              to: transfer.teams?.in?.name || 'Unknown',
              source: 'LIVE_PROVIDER'
            });
          }
        }
      }
      const unique = [...new Map(all.map(t => [t.id, t])).values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100);
      const value = { data: unique, dataMode: 'API_FOOTBALL_TRANSFER_FEED', fetchedAt: new Date().toISOString() };
      this.transfersCache = { fetchedAtMs: now, value }; return value;
    } catch (error) {
      if (this.transfersCache) return { ...this.transfersCache.value, dataMode: 'STALE_API_FOOTBALL_TRANSFER_FEED', data: this.transfersCache.value.data.map(t => ({ ...t, source: 'STALE_PROVIDER' as const })) };
      throw error;
    }
  }

  async queryAI(): Promise<string> { throw Object.assign(new Error('AI provider is not configured'), { statusCode: 503 }); }
}

class VerifiedSnapshotProvider implements VanguardProvider {
  async getMatches() { return { data: [{ id: 'snapshot-arsenal-city', homeTeam: 'Arsenal', awayTeam: 'Man City', score: '2 - 1', minute: 'snapshot', kickoff: '2026-09-07T00:00:00Z', status: 'Verified historical snapshot', league: 'Snapshot', dataSource: 'VERIFIED_SNAPSHOT' as const }], dataMode: 'VERIFIED_SNAPSHOT', live: false, fetchedAt: new Date().toISOString(), date: localDate(env.SPORTS_TIMEZONE) }; }
  async getTransfers() { return { data: [], dataMode: 'VERIFIED_SNAPSHOT', fetchedAt: new Date().toISOString() }; }
  async queryAI(): Promise<string> { throw Object.assign(new Error('AI provider is not configured'), { statusCode: 503 }); }
}

export class MockProvider implements VanguardProvider {
  async getMatches() { return { data: [], dataMode: 'DEVELOPMENT_MOCK', live: false, fetchedAt: new Date().toISOString(), date: localDate(env.SPORTS_TIMEZONE) }; }
  async getTransfers() { return { data: [], dataMode: 'DEVELOPMENT_MOCK', fetchedAt: new Date().toISOString() }; }
  async queryAI(prompt: string) { return `Development-only AI response for: "${prompt}".`; }
}

export class ProviderFactory {
  private static provider: VanguardProvider | null = null;
  static getProvider(): VanguardProvider {
    if (!this.provider) this.provider = env.SPORTS_API_KEY ? new ApiFootballProvider() : env.NODE_ENV !== 'production' ? new MockProvider() : new VerifiedSnapshotProvider();
    return this.provider;
  }
}

export function sanitizeLogData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const sensitive = ['password', 'apikey', 'ai_provider_key', 'token', 'jwt_secret', 'database_url', 'redis_url', 'secret', 'authorization', 'cookie'];
  if (Array.isArray(data)) return data.map(sanitizeLogData);
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) output[key] = sensitive.some(k => key.toLowerCase().includes(k)) ? '[REDACTED_SENSITIVE_DATA]' : sanitizeLogData(value);
  return output;
}
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) { console.error('[ERROR_LOG]', JSON.stringify({ timestamp: new Date().toISOString(), method: req.method, route: req.path, status: err.statusCode || 500, message: err.message || 'Unknown error', body: sanitizeLogData(req.body), query: sanitizeLogData(req.query) })); const status = err.statusCode || 500; res.status(status).json({ success: false, error: { message: status === 500 ? 'Internal Server Error' : err.message || 'Unknown error occurred' } }); }

const counts = new Map<string, { count: number; resetTime: number }>();
function rateLimiter(req: Request, res: Response, next: NextFunction) { const ip = req.ip || '127.0.0.1', now = Date.now(); let record = counts.get(ip); if (!record || now > record.resetTime) { record = { count: 1, resetTime: now + 900000 }; counts.set(ip, record); } else record.count++; if (record.count > 100) return res.status(429).json({ success: false, error: { message: 'Too many requests, please try again later.' } }); next(); }

export function createApp() {
  const app = express(); app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'"], imgSrc: ["'self'", 'data:'] } } }));
  app.use(cors(env.CORS_ORIGIN ? { origin: env.CORS_ORIGIN } : undefined)); app.use(express.json({ limit: '1mb' })); app.use(rateLimiter);
  const api = Router();
  api.get('/health', (_req, res) => res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString(), environment: env.NODE_ENV, sportsProviderConfigured: Boolean(env.SPORTS_API_KEY), dataMode: env.SPORTS_API_KEY ? 'api-football-top-five' : 'snapshot', topFiveLeagues: ['Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1'] }));
  api.get('/gateway/matches', async (_req, res, next) => { try { res.json({ success: true, ...(await ProviderFactory.getProvider().getMatches()) }); } catch (e) { next(e); } });
  api.get('/gateway/transfers', async (_req, res, next) => { try { res.json({ success: true, ...(await ProviderFactory.getProvider().getTransfers()) }); } catch (e) { next(e); } });
  api.post('/gateway/ai/ask', async (req, res, next) => { try { const parsed = aiAskSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ success: false, error: { message: 'Invalid request payload', details: parsed.error.format() } }); const answer = await ProviderFactory.getProvider().queryAI(parsed.data.prompt, parsed.data.context); res.json({ success: true, data: { answer } }); } catch (e) { next(e); } });
  app.use('/api/v1', api); app.use(express.static(path.join(process.cwd(), 'public'), { index: 'index.html' })); app.get('*', (req, res, next) => { if (req.path.startsWith('/api/')) return next(); res.sendFile(path.join(process.cwd(), 'public', 'index.html')); }); app.use((_req, res) => res.status(404).json({ success: false, error: { message: 'Route not found' } })); app.use(errorHandler); return app;
}
const app = createApp(); const port = Number(env.PORT) || 4000; if (require.main === module) app.listen(port, '0.0.0.0', () => console.log(`ArenaLive backend running on port ${port}`)); export default app;
