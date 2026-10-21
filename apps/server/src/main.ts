import { createServer } from './server.js';

export const app = createServer({
  dbPath: process.env.COLLAB_DB_PATH ?? 'collab.db',
  allowLegacyIdentityHeader: process.env.COLLAB_DEV_AUTH_BYPASS === '1',
  ...(process.env.COLLAB_AGENT_CONFIG_JSON === undefined ? {} : { agentConfigJson: process.env.COLLAB_AGENT_CONFIG_JSON }),
});

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 8787);
  void app.listen({ port, host: process.env.HOST ?? '127.0.0.1' }).then(() => app.log.info(`server listening on ${port}`));
}
