import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {config} from '../config.mjs';
import {parseM3u,providerIdentity,providerUrl,competitionList,competitionIds} from './catalog.mjs';
import {parseXmltv,matchGuide,channelSchedule} from './guide.mjs';
import {fetchLiveResource} from './fetch.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const LIVE_DIR=process.env.LIVE_TV_DIR || path.join(path.dirname(config.dbPath || path.join(repo,'data.sqlite')),'live-tv');
let state={channels:[],name:'Live TV',preferredLanguage:'English',maxConnections:1,guideUrl:null,guideStatus:'missing',guideUpdatedAt:null,guideError:null,importedAt:null};
let guide={channels:[],programmes:[]},matches=new Map(),loaded=false,loading=null,refreshing=null,mutation=Promise.resolve();
const catalogPath=path.join(LIVE_DIR,'catalog.json'),guidePath=path.join(LIVE_DIR,'guide.json');
async function atomic(file,value){await fs.mkdir(LIVE_DIR,{recursive:true});const temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(value),{mode:0o600});await fs.rename(temporary,file)}
function enqueue(fn){const operation=mutation.then(fn);mutation=operation.catch(()=>{});return operation}
export async function ensureLiveLoaded(){
  if(loaded)return;if(loading)return loading;
  loading=(async()=>{try{state={...state,...JSON.parse(await fs.readFile(catalogPath,'utf8'))}}catch(e){if(e.code!=='ENOENT')throw Error('Live TV configuration could not be read.')}
    try{guide=JSON.parse(await fs.readFile(guidePath,'utf8'))}catch{}
    matches=matchGuide(state.channels,guide);loaded=true;
  })();try{await loading}finally{loading=null}
}
export const privateChannel=id=>state.channels.find(c=>c.id===id);
export const liveSettings=()=>({maxConnections:Math.max(1,Math.min(Number(state.maxConnections)||1,4)),preferredLanguage:state.preferredLanguage});
export function liveAdminStatus(){
  const now=Date.now();let matched=0,listed=0,informative=0;
  for(const c of state.channels){const s=channelSchedule(c,matches.get(c.id),now);if(s.guideId)matched++;if(s.programmes.length)listed++;if(s.programmes.some(p=>!p.generic))informative++}
  return {name:state.name,channels:state.channels.length,importedAt:state.importedAt,preferredLanguage:state.preferredLanguage,maxConnections:liveSettings().maxConnections,
    guide:{configured:!!state.guideUrl,status:refreshing?'refreshing':state.guideStatus,updatedAt:state.guideUpdatedAt,error:state.guideError,matchedChannels:matched,listedChannels:listed,informativeChannels:informative},
    providerStatus:state.providerStatus || null};
}
export async function importLivePlaylist(text,{guideUrl,preferredLanguage='English'}={}){
  const operation=mutation.then(async()=>{
    await ensureLiveLoaded();const parsed=parseM3u(text);let identity=providerIdentity(parsed.channels),providerStatus=null,maxConnections=1;
    if(identity){
      try{
        const {bytes}=await fetchLiveResource(providerUrl(identity,'/player_api.php'),{maxBytes:1024*1024,timeoutMs:20000});
        const a=JSON.parse(bytes.toString());
        if(Number(a.user_info?.auth)!==1)throw Error('Provider account was not accepted.');
        maxConnections=Math.max(1,Math.min(Number(a.user_info.max_connections)||1,4));providerStatus=a.user_info.status==='Active'?'active':'inactive';
        if(a.user_info.allowed_output_formats?.includes('m3u8'))for(const c of parsed.channels)c.url=c.url.replace(/\.ts(?=\?|$)/,'.m3u8');
      }catch{providerStatus='unverified'}
    }
    state={...state,...parsed,guideUrl:guideUrl || parsed.guideUrl || (identity?providerUrl(identity,'/xmltv.php'):null),preferredLanguage,
      maxConnections,providerStatus,importedAt:new Date().toISOString(),guideStatus:'missing',guideUpdatedAt:null,guideError:null};
    guide={channels:[],programmes:[]};matches=new Map();await atomic(catalogPath,state);await atomic(guidePath,guide);
    if(state.guideUrl)void refreshGuide().then(()=>{if(state.guideStatus==='missing'&&state.guideUrl)void refreshGuide()});
    return liveAdminStatus();
  });mutation=operation.catch(()=>{});return operation;
}
export async function refreshGuide(){
  await ensureLiveLoaded();if(refreshing)return refreshing;if(!state.guideUrl)return liveAdminStatus();
  const url=state.guideUrl,importedAt=state.importedAt;
  refreshing=(async()=>{
    try{const {bytes}=await fetchLiveResource(url,{timeoutMs:90000});let xml=bytes;
      if(bytes[0]===0x1f&&bytes[1]===0x8b){const {gunzipSync}=await import('node:zlib');xml=gunzipSync(bytes,{maxOutputLength:120*1024*1024})}
      const next=parseXmltv(xml.toString('utf8'));
      await enqueue(async()=>{
        if(state.importedAt!==importedAt||state.guideUrl!==url)return;
        guide=next;matches=matchGuide(state.channels,guide);state.guideStatus='ready';state.guideUpdatedAt=new Date().toISOString();state.guideError=null;
        await atomic(guidePath,guide);await atomic(catalogPath,state);
      });
    }catch{
      await enqueue(async()=>{
        if(state.importedAt!==importedAt||state.guideUrl!==url)return;
        state.guideStatus=state.guideUpdatedAt?'stale':'unavailable';state.guideError='Programme guide refresh failed. The saved guide is retained; try refreshing or provide another XMLTV source.';
        await atomic(catalogPath,state);
      });
    }
  })();try{await refreshing}finally{refreshing=null}return liveAdminStatus();
}
export async function updateLiveSettings({guideUrl,preferredLanguage,maxConnections}){
  const operation=mutation.then(async()=>{await ensureLiveLoaded();
    if(guideUrl!==undefined){if(guideUrl){const u=new URL(guideUrl);if(!['http:','https:'].includes(u.protocol))throw Error('Guide URL must use HTTP or HTTPS.')}state.guideUrl=guideUrl || null;state.guideStatus='missing';}
    if(preferredLanguage!==undefined){if(!['English','Arabic','All'].includes(preferredLanguage))throw Error('Choose a supported language preference.');state.preferredLanguage=preferredLanguage}
    if(maxConnections!==undefined){const n=Number(maxConnections);if(!Number.isInteger(n)||n<1||n>4)throw Error('Choose between one and four upstream connections.');state.maxConnections=n}
    await atomic(catalogPath,state);if(guideUrl)void refreshGuide().then(()=>{if(state.guideStatus==='missing'&&state.guideUrl)void refreshGuide()});return liveAdminStatus();
  });mutation=operation.catch(()=>{});return operation;
}
export async function updateChannelMapping(id,{guideId,competitions,language}){
  const operation=mutation.then(async()=>{await ensureLiveLoaded();const c=privateChannel(id);if(!c)throw Error('Channel not found.');
    if(guideId!==undefined)c.guideOverride=String(guideId).slice(0,200)||null;
    if(competitions!==undefined){if(!Array.isArray(competitions)||competitions.some(id=>!competitionList().some(c=>c.id===id)))throw Error('Invalid competition.');c.competitions=[...new Set(competitions)]}
    if(language!==undefined){c.language=String(language).slice(0,50)||'Unspecified';c.languageSource='manual'}
    matches=matchGuide(state.channels,guide);await atomic(catalogPath,state);return {ok:true};
  });mutation=operation.catch(()=>{});return operation;
}
export function guideChannels(query=''){const q=query.toLowerCase();return guide.channels.filter(c=>!q||c.names.some(n=>n.toLowerCase().includes(q))||c.id.toLowerCase().includes(q)).slice(0,100)}
export async function liveCatalog({now=Date.now()}={}){
  await ensureLiveLoaded();
  const channels=state.channels.map(c=>{const schedule=channelSchedule(c,matches.get(c.id),now);return {id:c.id,name:c.name,group:c.group,region:c.region,
    logo:c.logo?`/api/live/channels/${c.id}/logo`:null,language:c.language,languageSource:c.languageSource,quality:c.quality,competitions:c.competitions,...schedule};});
  return {name:state.name,competitions:competitionList(),channels,languages:[...new Set(channels.map(c=>c.language))].sort(),
    preferredLanguage:state.preferredLanguage,serverTime:now,guide:liveAdminStatus().guide};
}
export function startGuideRefresh(){
  const tick=async()=>{try{await ensureLiveLoaded();if(state.guideUrl&&(!state.guideUpdatedAt||Date.now()-Date.parse(state.guideUpdatedAt)>4*3600000))await refreshGuide()}catch{console.warn('[live-tv] Guide refresh unavailable.')}};
  void tick();const timer=setInterval(tick,30*60000);timer.unref?.();return timer;
}
