import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {parseM3u,competitionIds,channelLanguage} from '../lib/live/catalog.mjs';
import {parseXmltv,xmltvTime,matchGuide,channelSchedule} from '../lib/live/guide.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mediawan-live-test-'));
process.env.LIVE_TV_DIR=dir;process.env.DB_PATH=path.join(dir,'db.sqlite');
const store=await import('../lib/live/store.mjs');
const {liveFfmpegArgs,canCopyLiveVideo,rewriteSourceManifest,stopAllLive}=await import('../lib/live/sessions.mjs');
const {mountLiveRoutes}=await import('../lib/live/routes.mjs');
after(async()=>{await stopAllLive();(await import('../lib/db.mjs')).closeDb();await fs.rm(dir,{recursive:true,force:true})});
const playlist=`#EXTM3U
#EXTINF:-1 tvg-id="pl" group-title="United Kingdom - Sports, Live" tvg-logo="https://example.com/private-logo.png",Sky Sports Premier League HD
https://example.com/channel?token=private-test-secret
#EXTINF:-1 group-title="Spain - Sports",DAZN LaLiga FHD
https://example.com/channel2
#EXTINF:-1,Not a web stream
file:///etc/passwd
#EXTINF:-1,Duplicate
https://example.com/channel2
`;
test('M3U preserves quoted commas, classifies dedicated channels and rejects non-web/duplicate streams',()=>{
 const p=parseM3u(playlist);assert.equal(p.channels.length,2);assert.equal(p.channels[0].group,'United Kingdom - Sports, Live');
 assert.equal(p.channels[0].language,'English');assert.deepEqual(p.channels[1].competitions,['la-liga']);
 assert.equal(p.channels[1].quality,'1080p');assert.equal(p.channels[0].id,parseM3u(playlist).channels[0].id);
 assert.throws(()=>parseM3u('not a playlist'));
});
test('competition classification does not guess broadcaster rights',()=>{
 assert.deepEqual(competitionIds('beIN Sports 1'),[]);assert.deepEqual(competitionIds('Sky Sports Premier League'),['premier-league']);
 assert.deepEqual(competitionIds('UEFA Europa League highlights'),['europa-league']);
 assert.equal(channelLanguage('English commentary','Spain','').language,'English');
 assert.equal(channelLanguage('Ca | Fr: TVA Sports','Canada','').language,'French');
 assert.equal(channelLanguage('|PT| NFL NETWORK HD','Arabic / MENA','').language,'Portuguese');
 assert.deepEqual(competitionIds('LALIGA TV HYPERMOTION'),['segunda']);
 assert.deepEqual(parseM3u('#EXTM3U\n#EXTINF:-1 group-title="Europe - UEFA CHAMPIONS LEAGUE",ES: M. GOLF HD\nhttps://example.com/golf').channels[0].competitions,[]);
});
const now=Date.UTC(2026,8,20,12);
const xml=`<?xml version="1.0"?><tv><channel id="pl"><display-name>Sky Sports Premier League</display-name></channel><channel id="200"><display-name>LaLiga</display-name></channel>
<programme channel="pl" start="20260920130000 +0200" stop="20260920160000 +0200"><title>Live: Premier League</title><desc>Team A &amp; Team B</desc></programme>
<programme channel="200" start="20260920110000 +0000" stop="20260920140000 +0000"><title>DAZN LaLiga FHD</title></programme></tv>`;
test('XMLTV converts zones, maps IDs and distinguishes filler from programmes',()=>{
 assert.equal(xmltvTime('20260920140000 +0200'),now);assert.equal(xmltvTime('20260920070000 -0500'),now);assert.equal(xmltvTime('invalid'),null);
 const guide=parseXmltv(xml,{now}),channels=parseM3u(playlist).channels;channels[1].streamId='200';
 const matches=matchGuide(channels,guide),a=channelSchedule(channels[0],matches.get(channels[0].id),now),b=channelSchedule(channels[1],matches.get(channels[1].id),now);
 assert.equal(a.now.description,'Team A & Team B');assert.equal(a.now.generic,false);assert.equal(a.now.eventLive,true);assert.equal(b.now.generic,true);assert.equal(b.guideId,'200');
 assert.throws(()=>parseXmltv('<!DOCTYPE tv [<!ENTITY x SYSTEM "file:///etc/passwd">]><tv>&x;</tv>',{now}));
});
test('ambiguous guide names remain unmatched',()=>{
 const c=parseM3u(playlist).channels[0];c.epgId=null;
 const m=matchGuide([c],{channels:[{id:'a',names:['UK: Sky Sports Premier League HD']},{id:'b',names:['Sky Sports Premier League FHD']}],programmes:[]});
 assert.equal(m.get(c.id).guideId,null);
});
test('repeated provider placeholders are not presented as fixtures',()=>{
 const channel={name:'Alkass 1',competitions:[]};
 const programmes=Array.from({length:8},(_,i)=>({title:'beIN Sports MAX',description:'',start:now+i*3600000,end:now+(i+1)*3600000,competitions:[]}));
 const s=channelSchedule(channel,{programmes},now);assert.ok(s.programmes.every(p=>p.generic));
 assert.equal(xmltvTime('20260230120000 +0000'),null);
});
test('relay rewrites relative variants, segments, maps and keys without exposing source URLs',()=>{
 const urls=[];const out=rewriteSourceManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n../secret/seg.ts\n','https://example.com/private/master.m3u8',(u)=>{urls.push(u);return '/private-relay/'+urls.length});
 assert.equal(urls.length,3);assert.match(out,/URI="\/private-relay\/1"/);assert.ok(!out.includes('example.com'));assert.equal(urls[2],'https://example.com/secret/seg.ts');
});
test('live encoder uses rolling HLS and compatible H264/AAC output',()=>{
 const args=liveFfmpegArgs('http://127.0.0.1/relay',{mode:'vaapi'});assert.ok(args.includes('h264_vaapi'));assert.ok(args.includes('aac'));
 assert.equal(args[args.indexOf('-hls_list_size')+1],'8');assert.match(args[args.indexOf('-hls_flags')+1],/delete_segments/);assert.ok(!args.includes('event'));
 assert.ok(liveFfmpegArgs('http://127.0.0.1/relay',{mode:'software'}).includes('libx264'));
 const copy=liveFfmpegArgs('http://127.0.0.1/relay',{mode:'copy'});assert.equal(copy[copy.indexOf('-c:v')+1],'copy');assert.ok(!copy.includes('-vf'));
 assert.ok(canCopyLiveVideo([{codec_type:'video',codec_name:'h264',width:1920,height:1080,pix_fmt:'yuv420p'}]));
 assert.equal(canCopyLiveVideo([{codec_type:'video',codec_name:'hevc',width:1920,height:1080,pix_fmt:'yuv420p'}]),false);
});
test('public catalogue omits upstream credentials and auth protects import, media and internal relay',async()=>{
 await store.importLivePlaylist(playlist);const data=await store.liveCatalog();
 assert.equal(data.channels.length,2);assert.ok(!JSON.stringify(data).includes('private-test-secret'));assert.ok(!JSON.stringify(data).includes('https://example.com'));
 const app=express();app.use(express.json());mountLiveRoutes(app,{requireAuth:(req,res,next)=>{if(!req.headers['x-test-user'])return res.sendStatus(401);req.user={id:1,role:req.headers['x-test-user']};next()},requireAdmin:(req,res,next)=>req.user.role==='admin'?next():res.sendStatus(403)});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
 assert.equal((await fetch(base+'/api/live/catalog')).status,401);
 assert.equal((await fetch(base+'/api/admin/live',{headers:{'x-test-user':'user'}})).status,403);
 assert.equal((await fetch(base+'/api/admin/live',{headers:{'x-test-user':'admin'}})).status,200);
 assert.equal((await fetch(base+'/media/live/missing/index.m3u8')).status,401);
 assert.equal((await fetch(base+'/internal/live/missing/private.ts')).status,404);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
});
