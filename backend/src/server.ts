import express, { Request, Response, NextFunction, Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  SPORTS_API_KEY: z.string().optional(),
  SPORTS_TIMEZONE: z.string().default('America/New_York'),
  SPORTS_CACHE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  TRANSFERS_CACHE_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  TRANSFER_TEAM_IDS: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  CORS_ORIGIN: z.string().optional()
}).refine(v => v.NODE_ENV !== 'production' || Boolean(v.JWT_SECRET?.trim()), { message: 'JWT_SECRET is required in production', path: ['JWT_SECRET'] });

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) { console.error('[ENV_CONFIG_ERROR]', parsed.error.format()); process.exit(1); }
export const env = parsed.data;

export const aiAskSchema = z.object({ prompt: z.string().min(1).max(1000), context: z.record(z.unknown()).optional() });

const TOP_FIVE = new Set([39, 140, 78, 135, 61]);
const TOP_FIVE_NAMES = ['Premier League', 'La Liga', 'Bundesliga', 'Serie A', 'Ligue 1'];
const DEFAULT_TRANSFER_TEAM_IDS = [42, 40, 49, 541, 529, 530, 157, 165, 505, 489, 496, 85];
const LIVE_CODES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE']);
const FINAL_CODES = new Set(['FT', 'AET', 'PEN']);

type MatchSource = 'LIVE_PROVIDER' | 'SCHEDULED_PROVIDER' | 'COMPLETED_PROVIDER' | 'STALE_PROVIDER' | 'VERIFIED_SNAPSHOT';
type TransferSource = 'LIVE_PROVIDER' | 'STALE_PROVIDER';

export interface MatchData { id:string; homeTeam:string; awayTeam:string; score:string; minute:string; kickoff:string; status:string; league:string; venue?:string; dataSource:MatchSource; }
export interface TransferData { id:string; player:string; date:string; type:string; from:string; to:string; source:TransferSource; }
export interface MatchesResult { data: MatchData[]; dataMode: string; live: boolean; fetchedAt: string; date: string; }
export interface TransfersResult { data: TransferData[]; dataMode: string; fetchedAt: string; coverage: string; }
export interface VanguardProvider { getMatches():Promise<MatchesResult>; getTransfers():Promise<TransfersResult>; queryAI(prompt:string, context?:unknown):Promise<string>; }

type Fixture = { fixture?:{id?:number;date?:string;venue?:{name?:string};status?:{short?:string;long?:string;elapsed?:number|null}};league?:{id?:number;name?:string};teams?:{home?:{name?:string};away?:{name?:string}};goals?:{home?:number|null;away?:number|null}};
type TransferPlayer = { player?:{id?:number;name?:string};transfers?:Array<{date?:string;type?:string;teams?:{in?:{name?:string};out?:{name?:string}}}> };
interface FixtureResponse { response?: Fixture[]; errors?:Record<string,unknown> }
interface TransferResponse { response?: TransferPlayer[]; errors?:Record<string,unknown> }

function localDate(timeZone:string):string {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const get=(x:string)=>parts.find(p=>p.type===x)?.value||'';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function transferTeamIds():number[] {
  const configured=(env.TRANSFER_TEAM_IDS||'').split(',').map(x=>Number(x.trim())).filter(Number.isInteger);
  return [...new Set(configured.length?configured:DEFAULT_TRANSFER_TEAM_IDS)];
}
function mapFixture(f:Fixture):MatchData|null {
  const id=f.fixture?.id, home=f.teams?.home?.name, away=f.teams?.away?.name, leagueId=f.league?.id;
  if(!id||!home||!away||!f.fixture?.date)return null;
  if(!TOP_FIVE.has(leagueId??-1))return null;
  const short=f.fixture.status?.short||'NS';
  const live=LIVE_CODES.has(short), final=FINAL_CODES.has(short);
  const score=f.goals?.home==null||f.goals?.away==null?'—':`${f.goals.home} - ${f.goals.away}`;
  return {id:String(id),homeTeam:home,awayTeam:away,score,minute:live&&f.fixture.status?.elapsed!=null?`${f.fixture.status.elapsed}'`:short,kickoff:f.fixture.date,status:f.fixture.status?.long||short,league:f.league?.name||'Football',venue:f.fixture.venue?.name,dataSource:live?'LIVE_PROVIDER':final?'COMPLETED_PROVIDER':'SCHEDULED_PROVIDER'};
}

class ApiFootballProvider implements VanguardProvider {
  private matchCache:{date:string;at:number;value:MatchesResult}|null=null;
  private transferCache:{at:number;value:TransfersResult}|null=null;
  private async request<T>(url:URL):Promise<T>{
    if(!env.SPORTS_API_KEY)throw Object.assign(new Error('Sports provider is not configured'),{statusCode:503});
    const r=await fetch(url,{headers:{'x-apisports-key':env.SPORTS_API_KEY,accept:'application/json'},signal:AbortSignal.timeout(9000)});
    const body=await r.json() as T&{errors?:Record<string,unknown>};
    if(!r.ok||(body.errors&&Object.keys(body.errors).length))throw Object.assign(new Error(r.status===429?'Sports provider rate limit reached':'Sports provider request failed'),{statusCode:r.status===429?429:502});
    return body;
  }
  async getMatches():Promise<MatchesResult>{
    const date=localDate(env.SPORTS_TIMEZONE),now=Date.now(),fresh=env.SPORTS_CACHE_MINUTES*60000;
    if(this.matchCache?.date===date&&now-this.matchCache.at<fresh)return this.matchCache.value;
    try{
      const url=new URL('https://v3.football.api-sports.io/fixtures');url.searchParams.set('date',date);url.searchParams.set('timezone',env.SPORTS_TIMEZONE);
      const payload=await this.request<FixtureResponse>(url);
      const data:MatchData[]=(payload.response||[]).map(mapFixture).filter((x):x is MatchData=>Boolean(x)).sort((a:MatchData,b:MatchData)=>{const rank=(m:MatchData)=>m.dataSource==='LIVE_PROVIDER'?0:m.dataSource==='SCHEDULED_PROVIDER'?1:2;return rank(a)-rank(b)||a.kickoff.localeCompare(b.kickoff)});
      const value:MatchesResult={data,dataMode:'API_FOOTBALL_TOP_FIVE',live:data.some((m:MatchData)=>m.dataSource==='LIVE_PROVIDER'),fetchedAt:new Date().toISOString(),date};
      this.matchCache={date,at:now,value};return value;
    }catch(error){
      if(this.matchCache?.date===date)return {...this.matchCache.value,dataMode:'STALE_API_FOOTBALL_TOP_FIVE',data:this.matchCache.value.data.map((m:MatchData)=>({...m,dataSource:'STALE_PROVIDER' as const}))};
      throw error;
    }
  }
  async getTransfers():Promise<TransfersResult>{
    const now=Date.now(),fresh=env.TRANSFERS_CACHE_HOURS*3600000;
    if(this.transferCache&&now-this.transferCache.at<fresh)return this.transferCache.value;
    try{
      const all:TransferData[]=[];let successfulTeams=0;
      for(const teamId of transferTeamIds()){
        try{
          const url=new URL('https://v3.football.api-sports.io/transfers');url.searchParams.set('team',String(teamId));
          const payload=await this.request<TransferResponse>(url);successfulTeams++;
          for(const player of payload.response||[]){const playerName=player.player?.name;if(!playerName)continue;for(const t of player.transfers||[]){if(!t.date)continue;all.push({id:`${player.player?.id||playerName}-${t.date}-${t.teams?.out?.name||'unknown'}-${t.teams?.in?.name||'unknown'}`,player:playerName,date:t.date,type:t.type||'Transfer',from:t.teams?.out?.name||'Unknown',to:t.teams?.in?.name||'Unknown',source:'LIVE_PROVIDER'});}}
        }catch(teamError){console.warn('[TRANSFER_TEAM_ERROR]',teamId,teamError instanceof Error?teamError.message:'unknown');}
      }
      if(successfulTeams===0)throw Object.assign(new Error('Transfer provider is temporarily unavailable'),{statusCode:502});
      const data:TransferData[]=[...new Map(all.map((t:TransferData)=>[t.id,t])).values()].sort((a:TransferData,b:TransferData)=>b.date.localeCompare(a.date)).slice(0,100);
      const value:TransfersResult={data,dataMode:'API_FOOTBALL_TRANSFER_FEED',fetchedAt:new Date().toISOString(),coverage:`${successfulTeams} selected top-five-league clubs`};this.transferCache={at:now,value};return value;
    }catch(error){
      if(this.transferCache)return {...this.transferCache.value,dataMode:'STALE_API_FOOTBALL_TRANSFER_FEED',data:this.transferCache.value.data.map((t:TransferData)=>({...t,source:'STALE_PROVIDER' as const}))};
      throw error;
    }
  }
  async queryAI():Promise<string>{throw Object.assign(new Error('AI provider is not configured'),{statusCode:503});}
}

class VerifiedSnapshotProvider implements VanguardProvider {
  async getMatches():Promise<MatchesResult>{return{data:[],dataMode:'VERIFIED_SNAPSHOT',live:false,fetchedAt:new Date().toISOString(),date:localDate(env.SPORTS_TIMEZONE)}}
  async getTransfers():Promise<TransfersResult>{return{data:[],dataMode:'VERIFIED_SNAPSHOT',fetchedAt:new Date().toISOString(),coverage:'No live provider configured'}}
  async queryAI():Promise<string>{throw Object.assign(new Error('AI provider is not configured'),{statusCode:503});}
}
export class MockProvider implements VanguardProvider {
  async getMatches():Promise<MatchesResult>{return{data:[],dataMode:'DEVELOPMENT_MOCK',live:false,fetchedAt:new Date().toISOString(),date:localDate(env.SPORTS_TIMEZONE)}}
  async getTransfers():Promise<TransfersResult>{return{data:[],dataMode:'DEVELOPMENT_MOCK',fetchedAt:new Date().toISOString(),coverage:'Development mode'}}
  async queryAI(prompt:string):Promise<string>{return `Development-only AI response for: "${prompt}".`}
}
export class ProviderFactory {
  private static provider:VanguardProvider|null=null;
  static getProvider():VanguardProvider{if(!this.provider)this.provider=env.SPORTS_API_KEY?new ApiFootballProvider():env.NODE_ENV==='production'?new VerifiedSnapshotProvider():new MockProvider();return this.provider;}
}
function sanitize(value:unknown):unknown{if(Array.isArray(value))return value.map(sanitize);if(!value||typeof value!=='object')return value;const out:Record<string,unknown>={};const blocked=['key','token','secret','password','authorization','cookie','database_url'];for(const[k,v]of Object.entries(value))out[k]=blocked.some(x=>k.toLowerCase().includes(x))?'[REDACTED]':sanitize(v);return out;}

export function createApp(){
  const app=express();app.disable('x-powered-by');
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'"],styleSrc:["'self'","'unsafe-inline'"],connectSrc:["'self'"],imgSrc:["'self'",'data:']}}}));
  app.use(cors(env.CORS_ORIGIN?{origin:env.CORS_ORIGIN}:undefined));app.use(express.json({limit:'1mb'}));
  const counters=new Map<string,{count:number;reset:number}>();
  app.use((req,res,next)=>{const key=req.ip||'unknown',now=Date.now(),item=counters.get(key);const current=!item||now>item.reset?{count:1,reset:now+900000}:{count:item.count+1,reset:item.reset};counters.set(key,current);if(current.count>100)return res.status(429).json({success:false,error:{message:'Too many requests, please try again later.'}});next();});
  const api=Router();
  api.get('/health',(_req,res)=>res.json({success:true,status:'healthy',timestamp:new Date().toISOString(),environment:env.NODE_ENV,sportsProviderConfigured:Boolean(env.SPORTS_API_KEY),dataMode:env.SPORTS_API_KEY?'api-football-top-five':'snapshot',topFiveLeagues:TOP_FIVE_NAMES}));
  api.get('/gateway/matches',async(_req,res,next)=>{try{res.json({success:true,...await ProviderFactory.getProvider().getMatches()})}catch(e){next(e)}});
  api.get('/gateway/transfers',async(_req,res,next)=>{try{res.json({success:true,...await ProviderFactory.getProvider().getTransfers()})}catch(e){next(e)}});
  api.post('/gateway/ai/ask',async(req,res,next)=>{try{const body=aiAskSchema.safeParse(req.body);if(!body.success)return res.status(400).json({success:false,error:{message:'Invalid request payload'}});const answer=await ProviderFactory.getProvider().queryAI(body.data.prompt,body.data.context);res.json({success:true,data:{answer}})}catch(e){next(e)}});
  app.use('/api/v1',api);
  const publicDir=path.join(process.cwd(),'public');app.use(express.static(publicDir,{extensions:['html']}));
  app.get('*',(req,res,next)=>{if(req.path.startsWith('/api/'))return next();res.sendFile(path.join(publicDir,'index.html'))});
  app.use((req,res)=>res.status(404).json({success:false,error:{message:'Not Found'}}));
  app.use((err:any,req:Request,res:Response,_next:NextFunction)=>{console.error('[ERROR_LOG]',JSON.stringify({timestamp:new Date().toISOString(),method:req.method,route:req.path,status:err?.statusCode||500,message:err?.message||'Unknown error',body:sanitize(req.body),query:sanitize(req.query)}));const status=Number(err?.statusCode)||500;res.status(status).json({success:false,error:{message:status===500?'Internal Server Error':err?.message||'Request failed'}})});
  return app;
}
const app=createApp();if(require.main===module)app.listen(env.PORT,'0.0.0.0',()=>console.log(`ArenaLive backend listening on ${env.PORT}`));export default app;