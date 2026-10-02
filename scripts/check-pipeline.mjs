// Run inside the NAS container. Reads configuration and checks storage/tools;
// does not download media, print credentials, or contact a provider.
import { pipelineStatus } from "../lib/pipeline.mjs";
import { closeDb } from "../lib/db.mjs";

try {
  const state = await pipelineStatus();
  console.log("Mediawan · downloader and encoder setup\n");
  for (const check of state.setup.checks) console.log(`[${check.status}] ${check.label}: ${check.detail}`);
  console.log(`\nCache: ${state.downloader.cache.dir}`);
  console.log(`Encoder: ${state.encoder.mode}; remote target ${state.encoder.remoteMbps} Mbps`);
  if (!state.setup.ready) process.exitCode = 1;
} finally {
  closeDb();
}
