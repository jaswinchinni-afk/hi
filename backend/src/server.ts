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
  AI_PROVIDER_KEY: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  CORS_ORIGIN: z.string().optional()
}).refine(data => data.NODE_ENV !== 'production' || Boolean(data.JWT_SECRET?.trim()), {
  message: 'JWT_SECRET is strictly required in production environment and cannot be empty',
  path: ['JWT_SECRET']
});

const parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) {
  console.error('[ENV_CONFIG_ERROR]', parsedEnv.error.format());
  process.exit(1);
}
export const env = parsedEnv.data;

export const aiAskSchema = z.object({
  prompt: z.string().min(1).max(1000),
  context: z.object({
    matchId: z.string().optional(),
    playerId: z.string().optional(),
    teamId: z.string().optional(),
    transferId: z.string().optional(),
    apexFitGoal: z.string().optional()
  }).passthrough().optional()
});

export interface MatchData {
  id: string;
  homeTeam: string;
  awayTeam: string;
  score: string;
  minute: string;
  xG: { home: number; away: number };
  dataSource: 'DEVELOPMENT_MOCK' | 'VERIFIED_SNAPSHOT';
}

export interface VanguardProvider {
  getLiveMatches(): Promise<MatchData[]>;
  queryAI(prompt: string, context?: unknown): Promise<string>;
}

class VerifiedSnapshotProvider implements VanguardProvider {
  async getLiveMatches(): Promise<MatchData[]> {
    return [{ id: 'snapshot-arsenal-city', homeTeam: 'Arsenal', awayTeam: 'Man City', score: '2 - 1', minute: 'snapshot', xG: { home: 1.84, away: 1.12 }, dataSource: 'VERIFIED_SNAPSHOT' }];
  }
  async queryAI(): Promise<string> {
    throw Object.assign(new Error('AI provider is not configured'), { statusCode: 503 });
  }
}

export class MockProvider implements VanguardProvider {
  async getLiveMatches(): Promise<MatchData[]> {
    return [{ id: 'm-101', homeTeam: 'Real Madrid', awayTeam: 'Man City', score: '2 - 1', minute: "74'", xG: { home: 1.84, away: 1.12 }, dataSource: 'DEVELOPMENT_MOCK' }];
  }
  async queryAI(prompt: string): Promise<string> {
    return `Development-only AI response for: "${prompt}".`;
  }
}

export class ProviderFactory {
  static getProvider(): VanguardProvider {
    const type = process.env.VANGUARD_PROVIDER || (env.NODE_ENV === 'production' ? 'snapshot' : 'mock');
    if (type === 'mock' && env.NODE_ENV !== 'production') return new MockProvider();
    if (type === 'snapshot') return new VerifiedSnapshotProvider();
    throw Object.assign(new Error('No production sports provider is configured'), { statusCode: 503 });
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

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  console.error('[ERROR_LOG]', JSON.stringify({ timestamp: new Date().toISOString(), method: req.method, route: req.path, status: err.statusCode || 500, message: err.message || 'Unknown error', body: sanitizeLogData(req.body), query: sanitizeLogData(req.query) }));
  const status = err.statusCode || 500;
  res.status(status).json({ success: false, error: { message: status === 500 ? 'Internal Server Error' : err.message || 'Unknown error occurred' } });
}

const counts = new Map<string, { count: number; resetTime: number }>();
function rateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || '127.0.0.1';
  const now = Date.now();
  let record = counts.get(ip);
  if (!record || now > record.resetTime) { record = { count: 1, resetTime: now + 900000 }; counts.set(ip, record); } else record.count++;
  if (record.count > 100) return res.status(429).json({ success: false, error: { message: 'Too many requests, please try again later.' } });
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:']
      }
    }
  }));
  app.use(cors(env.CORS_ORIGIN ? { origin: env.CORS_ORIGIN } : undefined));
  app.use(express.json({ limit: '1mb' }));
  app.use(rateLimiter);

  const api = Router();
  api.get('/health', (_req, res) => res.json({ success: true, status: 'healthy', timestamp: new Date().toISOString(), environment: env.NODE_ENV, dataMode: env.NODE_ENV === 'production' ? 'snapshot-or-provider' : 'development' }));
  api.get('/gateway/matches', async (_req, res, next) => {
    try {
      const data = await ProviderFactory.getProvider().getLiveMatches();
      res.json({ success: true, data, meta: { dataMode: data[0]?.dataSource === 'VERIFIED_SNAPSHOT' ? 'VERIFIED_SNAPSHOT' : 'DEVELOPMENT_MOCK', live: data[0]?.dataSource !== 'VERIFIED_SNAPSHOT' } });
    } catch (e) { next(e); }
  });
  api.post('/gateway/ai/ask', async (req, res, next) => {
    try {
      const parsed = aiAskSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ success: false, error: { message: 'Invalid request payload', details: parsed.error.format() } });
      const provider = ProviderFactory.getProvider();
      const answer = await provider.queryAI(parsed.data.prompt, parsed.data.context);
      res.json({ success: true, data: { answer } });
    } catch (e) { next(e); }
  });

  app.use('/api/v1', api);
  app.use(express.static(path.join(process.cwd(), 'public'), { index: 'index.html' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  });
  app.use((_req, res) => res.status(404).json({ success: false, error: { message: 'Route not found' } }));
  app.use(errorHandler);
  return app;
}

const app = createApp();
const port = Number(env.PORT) || 4000;
if (require.main === module) app.listen(port, '0.0.0.0', () => console.log(`ArenaLive backend running on port ${port}`));
export default app;
