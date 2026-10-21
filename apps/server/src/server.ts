import Fastify, { type FastifyInstance } from 'fastify';
import { randomId, systemClock, type Clock } from '@collab/kernel';
import { ReviewService, type ReviewEvent } from '@collab/review';
import type { MemberDto } from '@collab/protocol';
import { AgentRuntime } from './agent-runtime.js';
import { AgentSettingsStore, parseEnvironmentAgentSettings } from './agent-settings.js';
import { AuthService } from './auth.js';
import type { CliProviderStatus } from './cli-providers.js';
import { Collaboration } from './collaboration.js';
import type { ServerContext } from './context.js';
import { AppEventBus } from './events.js';
import { AgentStore } from './infra/agent-store.js';
import { DocumentStore } from './infra/document-store.js';
import { LocalProjectService } from './infra/local-project.js';
import { ReviewStore } from './infra/review-store.js';
import { ModelProviderRegistry } from './model-providers.js';
import { registerAgentRoutes } from './routes/agent-routes.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerDocumentRoutes } from './routes/document-routes.js';
import { registerEventRoutes } from './routes/event-routes.js';
import { registerReviewRoutes } from './routes/review-routes.js';
import { registerWorkspaceRoutes } from './routes/workspace-routes.js';

export interface ServerConfig {
  dbPath: string;
  /** Trust `x-principal-id` without a session; for tests and scripts only. */
  allowLegacyIdentityHeader: boolean;
  /** Startup agent configuration (`COLLAB_AGENT_CONFIG_JSON`). */
  agentConfigJson?: string;
  clock?: Clock;
  logger?: boolean;
  /** Probe for the local CLIs; tests pass a fake instead of spawning real binaries. */
  inspectCli?: () => Promise<CliProviderStatus[]>;
}

/** Where a review event belongs, and the id clients refetch. */
function reviewEventTarget(event: ReviewEvent, reviewStore: ReviewStore): { docId: string; id: string } | undefined {
  if ('thread' in event) return { docId: event.thread.docId, id: event.thread.id };
  if ('suggestion' in event) return { docId: event.suggestion.docId, id: event.suggestion.id };
  const threadId = 'message' in event ? event.message.threadId : event.batch.threadId;
  const docId = reviewStore.getThread(threadId)?.docId;
  const id = 'message' in event ? event.message.id : event.batch.id;
  return docId === undefined ? undefined : { docId, id };
}

export function createServer(config: ServerConfig): FastifyInstance {
  const clock = config.clock ?? systemClock;
  const now = (): number => clock.now();
  const app = Fastify({ logger: config.logger ?? true });
  // Approval endpoints are POSTs without a body; an empty JSON body is an empty object.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.length === 0) { done(null, {}); return; }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      done(Object.assign(error instanceof Error ? error : new Error(String(error)), { statusCode: 400 }));
    }
  });

  const store = new DocumentStore(config.dbPath);
  store.seed();
  const reviewStore = new ReviewStore(store.db);
  const agentStore = new AgentStore(store.db);
  const events = new AppEventBus();
  const providers = new ModelProviderRegistry({ now, ...(config.inspectCli === undefined ? {} : { inspectCli: config.inspectCli }) });
  const agentSettings = new AgentSettingsStore(agentStore, parseEnvironmentAgentSettings(config.agentConfigJson), now);
  const reviewListeners: Array<(event: ReviewEvent) => void> = [];
  const reviewService = new ReviewService({
    clock,
    ids: randomId,
    repository: reviewStore,
    documents: { getDocument: (docId) => store.get(docId)?.handle },
    emit: (event) => reviewListeners.forEach((listener) => listener(event)),
  });
  const agents = new AgentRuntime({ store, reviewStore, reviewService, agentStore, settings: agentSettings, providers, eventBus: events, now, nextId: () => randomId.next() });
  const auth = new AuthService(store, { allowLegacyHeader: config.allowLegacyIdentityHeader, now });
  const visibleMembers = (docId: string, viewerId: string): MemberDto[] =>
    store.members(docId).filter((member) => member.kind !== 'agent' || agents.isVisible(docId, member.id, viewerId));
  let collaboration: Collaboration | undefined;
  const documentCreated = (docId: string): void => { collaboration?.open(docId); };
  const localProject = new LocalProjectService(store, () => randomId.next(), documentCreated);
  collaboration = new Collaboration({ store, events, reviewService, localProject, now, visibleMembers, principalId: (request) => auth.principalId(request.headers) });

  reviewListeners.push((event) => {
    const target = reviewEventTarget(event, reviewStore);
    if (target) events.publish({ type: event.type, docId: target.docId, occurredAt: now(), data: { id: target.id } });
  });
  reviewListeners.push((event) => agents.handle(event));

  const ctx: ServerContext = {
    store,
    reviewStore,
    agentStore,
    reviewService,
    agents,
    agentSettings,
    providers,
    localProject,
    collaboration,
    events,
    auth,
    now,
    newId: (prefix) => `${prefix}-${randomId.next().slice(0, 12)}`,
    documentCreated,
    documentRemoved: (docId) => { collaboration?.close(docId); agents.removeDocument(docId); },
    visibleMembers,
    membersChanged: (workspaceId) => {
      for (const document of store.workspaceDocuments(workspaceId)) events.publish({ type: 'members.changed', docId: document.id, occurredAt: now(), data: {} });
    },
  };
  registerAuthRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerDocumentRoutes(app, ctx);
  registerReviewRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerEventRoutes(app, ctx);

  // Edits made on the server (accepting a suggestion, restoring a version) must
  // be persisted even when nobody has the document open.
  for (const document of store.list()) collaboration.open(document.id);
  app.server.on('upgrade', (request, socket, head) => collaboration?.handleUpgrade(request, socket, head));
  return app;
}
