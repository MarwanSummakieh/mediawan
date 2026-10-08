import { configuration } from './src/config.mjs';
import { createApplication } from './src/app.mjs';
const config = configuration();
const application = createApplication(config);
const servers = [
  application.app.listen(config.port, config.host, () =>
    console.log(`Mediawan 2 listening on port ${config.port}`),
  ),
];
if (config.lanPort && config.lanPort !== config.port)
  servers.push(application.app.listen(config.lanPort, config.host));
application.start();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const server of servers) server.close();
  await application.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
