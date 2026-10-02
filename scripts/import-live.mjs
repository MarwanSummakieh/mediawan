// Run in the same environment as the server; the playlist remains in private storage.
import fs from 'node:fs/promises';
import {importLivePlaylist,refreshGuide,liveAdminStatus} from '../lib/live/store.mjs';
const file=process.argv[2];
if(!file){console.error('Usage: node scripts/import-live.mjs /private/channels.m3u');process.exit(1)}
try{await importLivePlaylist(await fs.readFile(file,'utf8'));await refreshGuide();console.log(JSON.stringify(liveAdminStatus(),null,2))}
catch{console.error('Live TV import failed. Check the playlist and server configuration.');process.exitCode=1}
