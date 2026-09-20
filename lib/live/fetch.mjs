import {assertSafeUrl} from '../security.mjs';

// Validate every redirect, bound response size/time, and never surface a
// credential-bearing upstream URL in an exception or a browser response.
export async function fetchLiveResource(url,{maxBytes=120*1024*1024,timeoutMs=60000,headers={}}={}) {
  const signal=AbortSignal.timeout(timeoutMs);
  for(let i=0;i<6;i++){
    await assertSafeUrl(url);
    let response;
    try{response=await fetch(url,{redirect:'manual',signal,headers:{'User-Agent':'Mediawan/1.0',...headers}})}catch{throw Error('The live TV provider did not respond.');}
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');await response.body?.cancel();if(!location)throw Error('The provider returned an invalid redirect.');url=new URL(location,url).href;continue;
    }
    if(!response.ok){await response.body?.cancel();throw Error(`The live TV provider returned HTTP ${response.status}.`);}
    const chunks=[];let size=0;
    try{for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw Error('Response exceeds size limit.');chunks.push(chunk)}}catch{throw Error('The provider response was incomplete or exceeded the size limit.');}
    return {bytes:Buffer.concat(chunks),type:response.headers.get('content-type') || ''};
  }
  throw Error('The provider redirected too many times.');
}

export async function openLiveStream(url,{signal,headers={}}={}) {
  for(let i=0;i<6;i++){
    await assertSafeUrl(url);
    let response;try{response=await fetch(url,{redirect:'manual',signal,headers:{'User-Agent':'VLC/3.0.21 LibVLC/3.0.21',...headers}})}catch{throw Error('The channel did not respond.');}
    if([301,302,303,307,308].includes(response.status)){
      const next=response.headers.get('location');await response.body?.cancel();if(!next)throw Error('Invalid channel redirect.');url=new URL(next,url).href;continue;
    }
    if(!response.ok){await response.body?.cancel();throw Error(`Channel returned HTTP ${response.status}.`)}
    return {response,url};
  }
  throw Error('Too many channel redirects.');
}
