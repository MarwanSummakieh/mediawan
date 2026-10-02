import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {config} from '../config.mjs';
import {capabilities} from '../transcode/probe.mjs';
import {status as vodStatus,setExternalSessionCount} from '../transcode/session.mjs';
import {signMediaToken,verifyMediaToken} from '../security.mjs';
import {LIVE_DIR,privateChannel,liveSettings,ensureLiveLoaded} from './store.mjs';
import {openLiveStream} from './fetch.mjs';

const sessions=new Map();let operations=Promise.resolve();
const serial=fn=>{const p=operations.then(fn);operations=p.catch(()=>{});return p};
setExternalSessionCount(()=>sessions.size);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const error=(message,status=503)=>Object.assign(Error(message),{status});
export function liveSessionStatus(){return [...sessions.values()].map(s=>({id:s.id,channelId:s.channelId,channelName:s.channelName,viewers:s.viewers.size,startedAt:s.startedAt,mode:s.mode,ready:s.ready,failed:!!s.failed,speed:s.speed||null,outputSeconds:s.outputSeconds||0}));}

export function liveFfmpegArgs(input,{mode='vaapi',device=config.transcode.device,mbps=config.transcode.remoteMbps}={}){
  const scale="scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  return ['-hide_banner','-loglevel','warning','-nostdin','-y','-progress','pipe:1','-stats_period','5',
    ...(mode==='vaapi'?['-vaapi_device',device||'/dev/dri/renderD128']:mode==='qsv'&&device?['-qsv_device',device]:[]),
    '-rw_timeout','20000000','-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','3',
    '-protocol_whitelist','http,https,tcp,tls,crypto','-analyzeduration','3000000','-probesize','4000000','-fflags','+genpts+discardcorrupt',
    '-i',input,'-map','0:v:0','-map','0:a:0?','-sn','-dn',
    ...(mode==='copy'?['-c:v','copy']:[
    '-vf',`${scale},${mode==='vaapi'?'format=nv12,hwupload':'format=yuv420p'}`,
    '-c:v',mode==='vaapi'?'h264_vaapi':mode==='qsv'?'h264_qsv':'libx264',
    ...(mode==='software'?['-preset','veryfast','-tune','zerolatency']:mode==='qsv'?['-preset','veryfast']:[]),
    '-b:v',`${mbps}M`,'-maxrate',`${mbps}M`,'-bufsize',`${mbps*2}M`,'-g','60','-force_key_frames','expr:gte(t,n_forced*2)']),
    '-c:a','aac','-b:a','128k','-ac','2','-ar','48000',
    '-f','hls','-hls_time','2','-hls_list_size','8','-hls_delete_threshold','2',
    '-hls_flags','delete_segments+independent_segments+program_date_time+temp_file',
    '-hls_segment_filename','segment-%09d.ts','index.m3u8'];
}

export function canCopyLiveVideo(streams){const v=streams.find(s=>s.codec_type==='video');return !!v&&v.codec_name==='h264'&&v.width<=1920&&v.height<=1080&&['yuv420p','yuvj420p'].includes(v.pix_fmt)}
async function compatibleVideo(input){try{
  const {stdout}=await promisify(execFile)(config.transcode.ffprobe,['-v','error','-rw_timeout','5000000','-analyzeduration','1500000','-probesize','1000000','-show_entries','stream=codec_type,codec_name,width,height,pix_fmt','-of','json',input],{timeout:12000,maxBuffer:1024*1024,windowsHide:true});
  return canCopyLiveVideo(JSON.parse(stdout).streams||[]);
}catch{return false}}

function addResource(s,url,key=false){
  const ext=key?'key':/\.m3u8(?:\?|$)/i.test(url)?'m3u8':/\.m4s(?:\?|$)/i.test(url)?'m4s':/\.mp4(?:\?|$)/i.test(url)?'mp4':'ts';
  const id=crypto.createHash('sha256').update(url).digest('hex').slice(0,24)+'.'+ext;
  s.resources.set(id,url);
  if(s.resources.size>1500){for(const k of [...s.resources.keys()].slice(1,501))s.resources.delete(k)}
  return `http://127.0.0.1:${config.port}/internal/live/${s.id}/${id}?key=${s.sourceKey}`;
}
export function rewriteSourceManifest(text,base,resolve){
  return text.split(/\r?\n/).map(line=>{
    if(line.startsWith('#'))return line.replace(/URI="([^"]+)"/g,(_m,uri)=>`URI="${resolve(new URL(uri,base).href,/^#EXT-X-KEY/.test(line))}"`);
    if(!line.trim())return line;return resolve(new URL(line.trim(),base).href,false);
  }).join('\n');
}

async function stop(s){
  if(!s||s.stopping)return;s.stopping=true;
  for(const a of s.upstream)a.abort();
  if(s.proc&&s.proc.exitCode===null){
    const exited=new Promise(resolve=>s.proc.once('close',resolve));s.proc.kill('SIGTERM');
    await Promise.race([exited,pause(2000)]);if(s.proc.exitCode===null){s.proc.kill('SIGKILL');await Promise.race([exited,pause(1500)])}
  }
  sessions.delete(s.id);
  if(s.dir)await fsp.rm(s.dir,{recursive:true,force:true}).catch(()=>{});
}
export async function startLiveChannel(channelId,userId){
  return serial(async()=>{
    await ensureLiveLoaded();const channel=privateChannel(channelId);if(!channel)throw error('Channel not found.',404);
    let s=[...sessions.values()].find(s=>s.channelId===channelId&&!s.failed&&!s.stopping);
    for(const old of [...sessions.values()])if(old.failed||!old.viewers.size)await stop(old);
    if(!s){
      if(sessions.size>=liveSettings().maxConnections)throw error('Another channel is already playing. This account has reached its simultaneous channel limit. Stop that stream before switching channels.',409);
      if(!config.transcode.enabled)throw error('The NAS encoder is disabled. Enable encoding in the server settings.');
      if(sessions.size+vodStatus().active>=config.transcode.maxSessions)throw error('The NAS encoder is busy. Stop another playback session and try again.',409);
      s={id:crypto.randomBytes(16).toString('hex'),sourceKey:crypto.randomBytes(24).toString('hex'),channelId,channelName:channel.name,viewers:new Map(),resources:new Map(),upstream:new Set(),startedAt:Date.now(),ready:false,failed:false};
      sessions.set(s.id,s);
      try{
        const caps=await capabilities();if(!caps.ffmpeg)throw error('FFmpeg is unavailable on this server.');
        s.mode=caps.hardwareMode==='none'?'software':caps.hardwareMode;
        const root=path.join(LIVE_DIR,'buffers');await fsp.mkdir(root,{recursive:true});s.dir=await fsp.mkdtemp(path.join(root,'live-'));
        const input=addResource(s,channel.url);if(await compatibleVideo(input))s.mode='copy';
        s.proc=spawn(config.transcode.ffmpeg,liveFfmpegArgs(input,{mode:s.mode}),{cwd:s.dir,stdio:['ignore','pipe','pipe'],windowsHide:true});
        let progress='';s.proc.stdout.on('data',b=>{progress+=b.toString();let nl;while((nl=progress.indexOf('\n'))>=0){const line=progress.slice(0,nl);progress=progress.slice(nl+1);const [k,v]=line.split('=');if(k==='speed')s.speed=Number.parseFloat(v)||null;if(k==='out_time_us')s.outputSeconds=Number(v)/1e6}});
        s.stderr='';s.proc.stderr.on('data',b=>{s.stderr=(s.stderr+b.toString()).slice(-3000)});
        s.proc.once('error',()=>{s.failed=true});s.proc.once('close',code=>{s.failed=true;s.exitCode=code});
        const deadline=Date.now()+30000;
        while(Date.now()<deadline&&!s.failed){
          try{const manifest=await fsp.readFile(path.join(s.dir,'index.m3u8'),'utf8');if(/#EXTINF:/.test(manifest)){s.ready=true;break}}catch{}
          await pause(200);
        }
        if(!s.ready)throw error('This channel could not start. Try another quality or channel; the provider may be offline or limiting playback.');
      }catch(e){await stop(s);throw e.status?e:error('Live playback could not start. Try another channel.');}
    }
    const viewer=crypto.randomBytes(16).toString('hex');s.viewers.set(viewer,{userId,lastSeen:Date.now()});
    const token=signMediaToken(`live:${s.id}:${viewer}`);
    return {sessionId:s.id,viewerId:viewer,playUrl:`/media/live/${s.id}/index.m3u8?v=${viewer}&t=${token}`,channelId,mode:s.mode};
  });
}
export function releaseLiveViewer(id,viewer,userId){return serial(async()=>{const s=sessions.get(id),v=s?.viewers.get(viewer);if(!v||v.userId!==userId)return;s.viewers.delete(viewer);if(!s.viewers.size)await stop(s)})}
export function heartbeatLiveViewer(id,viewer,userId){const s=sessions.get(id),v=s?.viewers.get(viewer);if(!v||v.userId!==userId||s.failed)return false;v.lastSeen=Date.now();return true}
export function liveMedia(req,res){
  const {id,file}=req.params,s=sessions.get(id),v=s?.viewers.get(req.query.v);
  if(!s||!v||!verifyMediaToken(`live:${id}:${req.query.v}`,req.query.t))return res.status(401).end();
  if(!/^(?:index\.m3u8|segment-\d{9}\.ts)$/.test(file))return res.status(404).end();
  v.lastSeen=Date.now();res.setHeader('Cache-Control','no-store');res.setHeader('Access-Control-Allow-Origin','*');
  if(file==='index.m3u8'){
    fsp.readFile(path.join(s.dir,file),'utf8').then(text=>{
      res.type('application/vnd.apple.mpegurl').send(text.replace(/^(segment-\d{9}\.ts)$/gm,`$1?v=${req.query.v}&t=${req.query.t}`));
    }).catch(()=>res.status(503).end());
  }else res.type('video/mp2t').sendFile(path.join(s.dir,file),e=>{if(e&&!res.headersSent)res.status(404).end()});
}

export async function liveSource(req,res){
  const peer=req.socket.remoteAddress,s=sessions.get(req.params.id),url=s?.resources.get(req.params.asset);
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)||!s||req.query.key!==s.sourceKey||!url)return res.status(404).end();
  const abort=new AbortController();s.upstream.add(abort);res.once('close',()=>{abort.abort();s.upstream.delete(abort)});
  const timer=setTimeout(()=>abort.abort(),30000);timer.unref?.();
  try{
    const headers={};if(req.headers.range)headers.Range=req.headers.range;
    const {response,url:finalUrl}=await openLiveStream(url,{signal:abort.signal,headers});
    const ct=response.headers.get('content-type')||'';
    if(/mpegurl/i.test(ct)||/\.m3u8(?:\?|$)/i.test(url)){
      let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024)throw Error('Manifest exceeds limit.');chunks.push(chunk)}
      const manifest=rewriteSourceManifest(Buffer.concat(chunks).toString(),finalUrl,(u,key)=>addResource(s,u,key));
      res.type('application/vnd.apple.mpegurl').send(manifest);
    }else{
      clearTimeout(timer);res.status(response.status);
      for(const h of ['content-type','content-length','content-range','accept-ranges']){const value=response.headers.get(h);if(value)res.setHeader(h,value)}
      const source=Readable.fromWeb(response.body);source.once('error',()=>res.destroy());source.pipe(res);
    }
  }catch{if(!res.headersSent)res.status(502).end();else res.destroy()}finally{clearTimeout(timer)}
}
export function startLiveReaper(){const timer=setInterval(()=>void serial(async()=>{const now=Date.now();for(const s of [...sessions.values()]){
  for(const [id,v] of s.viewers)if(now-v.lastSeen>45000)s.viewers.delete(id);
  if(s.ready){try{const stat=await fsp.stat(path.join(s.dir,'index.m3u8'));if(now-stat.mtimeMs>45000)s.failed=true}catch{s.failed=true}}
  if((s.ready&&!s.viewers.size)||s.failed)await stop(s)
}}),10000);timer.unref?.();return timer}
export async function stopAllLive(){await serial(async()=>{for(const s of [...sessions.values()])await stop(s)})}
