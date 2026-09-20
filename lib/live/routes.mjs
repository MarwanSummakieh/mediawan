import express from 'express';
import {ensureLiveLoaded,importLivePlaylist,liveCatalog,liveAdminStatus,refreshGuide,updateLiveSettings,updateChannelMapping,guideChannels,privateChannel} from './store.mjs';
import {startLiveChannel,releaseLiveViewer,heartbeatLiveViewer,liveSessionStatus,liveMedia,liveSource} from './sessions.mjs';
import {fetchLiveResource} from './fetch.mjs';
import {makeRateLimiter} from '../security.mjs';

export function mountLiveRoutes(app,{requireAuth,requireAdmin}){
  const wrap=fn=>async(req,res)=>{try{await ensureLiveLoaded();await fn(req,res)}catch(e){if(!res.headersSent)res.status(e.status||400).json({error:e.status?e.message:'Live TV could not complete this request. Check the playlist or guide and try again.'})}};
  app.get('/api/live/catalog',requireAuth,wrap(async(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json(await liveCatalog())}));
  const playLimiter=makeRateLimiter({windowMs:60000,max:30});
  app.post('/api/live/play',requireAuth,playLimiter,wrap(async(req,res)=>{res.setHeader('Cache-Control','no-store');res.json(await startLiveChannel(req.body?.channelId,req.user.id))}));
  app.post('/api/live/session/:id/:viewer/heartbeat',requireAuth,wrap(async(req,res)=>res.status(heartbeatLiveViewer(req.params.id,req.params.viewer,req.user.id)?200:410).json({ok:true})));
  app.delete('/api/live/session/:id/:viewer',requireAuth,wrap(async(req,res)=>{await releaseLiveViewer(req.params.id,req.params.viewer,req.user.id);res.json({ok:true})}));
  // A POST also allows sendBeacon on page exit. Ownership still comes from
  // the authenticated session, not from a user-controlled request body.
  app.post('/api/live/session/:id/:viewer/stop',requireAuth,wrap(async(req,res)=>{await releaseLiveViewer(req.params.id,req.params.viewer,req.user.id);res.json({ok:true})}));
  app.get('/media/live/:id/:file',liveMedia);
  app.get('/internal/live/:id/:asset',liveSource);

  const images=new Map();let imageBytes=0;
  app.get('/api/live/channels/:id/logo',requireAuth,async(req,res)=>{
    try{await ensureLiveLoaded();const c=privateChannel(req.params.id);if(!c?.logo)return res.status(404).end();
      let item=images.get(c.logo);
      if(!item){const result=await fetchLiveResource(c.logo,{maxBytes:1024*1024,timeoutMs:8000});
        const type=result.type.split(';')[0];if(!['image/png','image/jpeg','image/webp','image/gif','image/avif'].includes(type))return res.status(404).end();
        item={bytes:result.bytes,type};images.set(c.logo,item);imageBytes+=item.bytes.length;
        while(imageBytes>32*1024*1024){const key=images.keys().next().value;imageBytes-=images.get(key).bytes.length;images.delete(key)}
      }
      res.setHeader('Cache-Control','private, max-age=86400');res.type(item.type).send(item.bytes);
    }catch{res.status(404).end()}
  });

  const admin=[requireAuth,requireAdmin];
  app.get('/api/admin/live',...admin,wrap(async(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json({...liveAdminStatus(),sessions:liveSessionStatus()})}));
  app.post('/api/admin/live/import',...admin,express.text({type:['text/plain','application/x-mpegurl','audio/x-mpegurl','application/vnd.apple.mpegurl','application/octet-stream'],limit:'12mb'}),wrap(async(req,res)=>{
    if(typeof req.body!=='string')return res.status(400).json({error:'Choose an M3U playlist file.'});
    res.json(await importLivePlaylist(req.body));
  }));
  app.post('/api/admin/live/refresh',...admin,wrap(async(_req,res)=>res.json(await refreshGuide())));
  app.patch('/api/admin/live/settings',...admin,wrap(async(req,res)=>res.json(await updateLiveSettings(req.body || {}))));
  app.get('/api/admin/live/guide-channels',...admin,wrap(async(req,res)=>res.json({channels:guideChannels(String(req.query.q || ''))})));
  app.patch('/api/admin/live/channels/:id',...admin,wrap(async(req,res)=>res.json(await updateChannelMapping(req.params.id,req.body || {}))));
}
