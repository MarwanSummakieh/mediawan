import crypto from 'node:crypto';

export const COMPETITIONS = [
  ['premier-league','Premier League','PL','Football','#7256ba',/premier\s*lea(?:gue|uge)|\bEPL\b|الدوري الإنجليزي|الدوري الانجليزي/i],
  ['la-liga','LaLiga','LL','Football','#be4a3b',/^(?!.*(?:hypermotion|smartbank)).*(?:la\s*liga|laliga|primera divisi[oó]n|الدوري الاسباني|الدوري الإسباني)/i],
  ['segunda','LaLiga 2','LL2','Football','#b86a45',/hypermotion|smartbank|segunda divisi[oó]n/i],
  ['bundesliga','Bundesliga','BL','Football','#ab3843',/bundesliga|الدوري الالماني|الدوري الألماني/i],
  ['champions-league','Champions League','UCL','Football','#344d9d',/champions\s*league|liga\s*(?:de\s*)?campeones|دوري أبطال أوروبا|دوري ابطال اوروبا/i],
  ['europa-league','Europa League','UEL','Football','#b66727',/europa\s*league|الدوري الأوروبي|الدوري الاوروبي/i],
  ['conference-league','Conference League','UECL','Football','#397959',/conference\s*league|دوري المؤتمر/i],
  ['serie-a','Serie A','SA','Football','#3478a5',/serie\s*a\b|الدوري الايطالي|الدوري الإيطالي/i],
  ['ligue-1','Ligue 1','L1','Football','#686c28',/ligue\s*1\b|الدوري الفرنسي/i],
  ['world-cup','World Cup','WC','Football','#94713c',/world\s*cup|كأس العالم/i],
  ['nfl','NFL','NFL','American football','#31548a',/\bNFL\b|national football league|american football/i],
  ['nhl','NHL','NHL','Ice hockey','#65778c',/\bNHL\b|national hockey league/i],
  ['formula-1','Formula 1','F1','Motorsport','#b74040',/formula\s*1|formula\s*one|\bF1\b|فورمولا/i],
  ['nba','NBA','NBA','Basketball','#976431',/\bNBA\b|national basketball association/i],
  ['tennis','Tennis','TEN','Tennis','#748139',/tennis|wimbledon|\bATP\b|\bWTA\b|تنس/i],
  ['rugby','Rugby','RUG','Rugby','#35766d',/rugby|top\s*14|six nations/i],
  ['combat','Combat sports','UFC','Combat sports','#98543d',/\bUFC\b|\bWWE\b|boxing|combat|مصارعة|ملاكمة/i],
].map(([id,name,code,sport,color,pattern])=>({id,name,code,sport,color,pattern}));

export function competitionIds(text) {
  return COMPETITIONS.filter(c=>c.pattern.test(text || '')).map(c=>c.id);
}
export const competitionList = () => COMPETITIONS.map(({pattern,...c})=>c);
const REGIONS = [
  ['Arabic / MENA','Arabic'],['United Kingdom','English'],['United States','English'],['Canada','English'],
  ['Australia','English'],['Denmark','Danish'],['Spain','Spanish'],['Germany','German'],['Austria','German'],
  ['France','French'],['Italy','Italian'],['Norway','Norwegian'],['Sweden','Swedish'],['Netherlands','Dutch'],
  ['Portugal','Portuguese'],['Brazil','Portuguese'],['Argentina','Spanish'],['Mexico','Spanish'],['Latin America','Spanish'],
  ['Turkey','Turkish'],['Greece','Greek'],['Poland','Polish'],['Romania','Romanian'],['Bulgaria','Bulgarian'],
  ['Russia','Russian'],['Albania','Albanian'],['Finland','Finnish'],['Hungary','Hungarian'],['Kurdistan','Kurdish'],
  ['Ukraine','Ukrainian'],['Slovenia','Slovenian'],['Israel','Hebrew'],
];
export function channelLanguage(name, group, explicit) {
  const value = String(explicit || '').trim();
  if(value) return {language:({en:'English',eng:'English',ar:'Arabic',ara:'Arabic',da:'Danish',dan:'Danish',de:'German',deu:'German',es:'Spanish',spa:'Spanish',fr:'French',fra:'French'})[value.toLowerCase()] || value,languageSource:'playlist'};
  if(/\b(?:french|fran[cç]ais)\b|^ca\s*\|\s*fr\s*:/i.test(name))return {language:'French',languageSource:'channel label'};
  const prefix=name.match(/^\s*(?:\|([a-z]{2,3})\||([a-z]{2,3})\s*:)/i);
  const prefixLanguage=({uk:'English',usa:'English',us:'English',au:'English',es:'Spanish',de:'German',fr:'French',pt:'Portuguese',it:'Italian',nl:'Dutch',dk:'Danish',tr:'Turkish'})[(prefix?.[1]||prefix?.[2]||'').toLowerCase()];
  if(prefixLanguage)return {language:prefixLanguage,languageSource:'channel label'};
  if(/arabi|arabic|بالعربي/.test(`${name} ${group}`.toLowerCase()))return {language:'Arabic',languageSource:'channel label'};
  if(/\b(?:english|eng)\b/i.test(name))return {language:'English',languageSource:'channel label'};
  const region = REGIONS.find(([r])=>group.startsWith(r));
  return {language:region?.[1] || 'Unspecified',languageSource:region ? 'region' : 'unknown'};
}
export function channelKey(name) {
  return String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/\[[^\]]*\]|\|[^|]*\|/g,' ').replace(/^\s*[a-z]{2,5}\s*[:|]\s*/,'')
    .replace(/\b(?:fhd|uhd|hd|sd|hevc|h265|h264|4\s*k|8\s*k|vip)\b/g,' ')
    .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
export function parseAttributes(line) {
  const out = {};
  for(const m of line.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}
export function parseM3u(text) {
  if(typeof text!=='string' || Buffer.byteLength(text)>12*1024*1024)throw Error('Playlist is too large (12 MB maximum).');
  if(!text.replace(/^\uFEFF/,'').trimStart().startsWith('#EXTM3U'))throw Error('Choose an extended M3U playlist.');
  const channels=[],seen=new Set();let pending=null,header={};
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim();
    if(line.startsWith('#EXTM3U'))header=parseAttributes(line);
    else if(line.startsWith('#EXTINF:')){
      const attrs=parseAttributes(line);let quoted=false,quote='',comma=-1;
      for(let i=0;i<line.length;i++){if(!quoted && /["']/.test(line[i])){quoted=true;quote=line[i]}else if(quoted&&line[i]===quote)quoted=false;else if(!quoted&&line[i]===','){comma=i;break}}
      pending={attrs,name:(comma>=0?line.slice(comma+1):attrs['tvg-name'] || '').trim()};
    } else if(line && !line.startsWith('#') && pending){
      let url;try{url=new URL(line)}catch{pending=null;continue}
      if(!['http:','https:'].includes(url.protocol)||!pending.name){pending=null;continue}
      if(seen.has(url.href)){pending=null;continue}seen.add(url.href);
      const a=pending.attrs,group=a['group-title'] || 'Other channels',name=pending.name;
      const id=crypto.createHash('sha256').update(url.href).digest('hex').slice(0,24);
      const quality=/\b(?:4\s*k|uhd)\b/i.test(name)?'4K':/\bfhd\b/i.test(name)?'1080p':/\bhd\b/i.test(name)?'HD':/\bsd\b/i.test(name)?'SD':'Auto';
      const streamId=url.pathname.match(/\/live\/[^/]+\/[^/]+\/(\d+)\.(?:ts|m3u8)$/)?.[1] || null;
      const groups=/^Europe - UEFA CHAMPIONS LEAGUE$/i.test(group)?['champions-league']:/^Spain - (?:LaLiga|LALIGA ARABI بالعربي|LALIGA SPORTS UHD \/ 4K)$/i.test(group)?['la-liga']:/^Spain - M\+ LIGA CAMPEONES/i.test(group)?['champions-league']:[];
      const competitions=[...new Set([...competitionIds(name),...groups])].filter(c=>c!=='la-liga'||!competitionIds(name).includes('segunda'));
      channels.push({id,name,group,url:url.href,logo:a['tvg-logo'] || null,epgId:a['tvg-id'] || null,streamId,quality,...channelLanguage(name,group,a['tvg-language'] || a['language']),competitions,region:group.split(' - ')[0]});
      pending=null;
      if(channels.length>12000)throw Error('Playlist has too many channels (12,000 maximum).');
    }
  }
  if(!channels.length)throw Error('No HTTP live channels were found in this playlist.');
  return {name:header['playlist-name'] || 'Live TV',guideUrl:(header['url-tvg'] || header['x-tvg-url'] || '').split(',')[0] || null,channels};
}

export function providerIdentity(channels) {
  const first=channels[0];if(!first)return null;
  const u=new URL(first.url),m=u.pathname.match(/^\/live\/([^/]+)\/([^/]+)\/\d+\.(?:ts|m3u8)$/);
  if(!m)return null;
  const identity={origin:u.origin,username:decodeURIComponent(m[1]),password:decodeURIComponent(m[2])};
  if(!channels.every(c=>{const x=new URL(c.url);return x.origin===u.origin&&x.pathname.startsWith(`/live/${m[1]}/${m[2]}/`)}))return null;
  return identity;
}
export function providerUrl(identity, endpoint, action) {
  const u=new URL(endpoint,identity.origin);u.searchParams.set('username',identity.username);u.searchParams.set('password',identity.password);if(action)u.searchParams.set('action',action);return u.href;
}
