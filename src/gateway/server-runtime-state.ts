import type { Server as HttpServer } from "node:http";
import { WebSocketServer } from "ws";
import type { CliDeps } from "../cli/deps.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { HooksConfigResolved } from "./hooks.js";
import type { DedupeEntry } from "./server-shared.js";
import type { GatewayTlsRuntime } from "./server/tls.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostHandler, createCanvasHostHandler } from "../canvas-host/server.js";
import { resolveGatewayListenHosts } from "./net.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  type ChatRunEntry,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { createGatewayHooksRequestHandler } from "./server/hooks.js";
import { listenGatewayHttpServer } from "./server/http-listen.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";

/**
 * 创建 Gateway 核心运行时状态 (Runtime State)
 * ----------------------------------------
 * 这个函数是 Gateway 的“造物主”。它负责从无到有地构建出 Gateway 运行所需的所有物理设施。
 * 
 * 主要构建对象：
 * 1. **Canvas Host**: 前端 UI 渲染服务。
 * 2. **HTTP Servers**: Node.js 原生 HTTP 服务，承载 API 和静态资源。
 * 3. **WebSocket Server**: 实时通信的核心，处理所有长连接。
 * 4. **Broadcaster**: 消息广播系统，负责将事件分发给连接的客户端。
 * 5. **State Maps**: 各种内存中的状态表（Clients, Dedupe, ChatRuns 等）。
 * 
 * 返回值包含了一个完整的、已经启动（正在监听）的运行时环境。
 */
export async function createGatewayRuntimeState(params: {
  cfg: import("../config/config.js").OpenClawConfig;
  bindHost: string;
  port: number;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  resolvedAuth: ResolvedGatewayAuth;
  gatewayTls?: GatewayTlsRuntime;
  hooksConfig: () => HooksConfigResolved | null;
  pluginRegistry: PluginRegistry;
  deps: CliDeps;
  canvasRuntime: RuntimeEnv;
  canvasHostEnabled: boolean;
  allowCanvasHostInTests?: boolean;
  logCanvas: { info: (msg: string) => void; warn: (msg: string) => void };
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
}): Promise<{
  canvasHost: CanvasHostHandler | null;
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  agentRunSeq: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  chatRunState: ReturnType<typeof createChatRunState>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  toolEventRecipients: ReturnType<typeof createToolEventRecipientRegistry>;
}> {
  // 1. 初始化 Canvas Host (前端界面服务)
  // ----------------------------------------------------------------
  // Canvas Host 是 OpenClaw 的前端容器，负责渲染 Control UI。
  // 它本质上是一个静态文件服务器 + SSR (如果启用)。
  let canvasHost: CanvasHostHandler | null = null;
  if (params.canvasHostEnabled) {
    try {
      const handler = await createCanvasHostHandler({
        runtime: params.canvasRuntime,
        rootDir: params.cfg.canvasHost?.root,
        basePath: CANVAS_HOST_PATH,
        allowInTests: params.allowCanvasHostInTests,
        liveReload: params.cfg.canvasHost?.liveReload,
      });
      if (handler.rootDir) {
        canvasHost = handler;
        params.logCanvas.info(
          `canvas host mounted at http://${params.bindHost}:${params.port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
        );
      }
    } catch (err) {
      params.logCanvas.warn(`canvas host failed to start: ${String(err)}`);
    }
  }

  // 2. 初始化客户端集合与广播器
  // ----------------------------------------------------------------
  // clients 集合保存了当前所有活跃的 WebSocket 连接。
  // broadcaster 是一个工具函数，遍历 clients 并发送消息。
  const clients = new Set<GatewayWsClient>();
  const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

  // 3. 准备 HTTP 请求处理器 (Request Handlers)
  // ----------------------------------------------------------------
  // 这些 handlers 定义了 HTTP 路由逻辑。
  // - Hooks Handler: 处理外部 Webhook 请求 (POST /hooks/...)
  // - Plugins Handler: 处理插件自定义的 HTTP 请求
  const handleHooksRequest = createGatewayHooksRequestHandler({
    deps: params.deps,
    getHooksConfig: params.hooksConfig,
    bindHost: params.bindHost,
    port: params.port,
    logHooks: params.logHooks,
  });

  const handlePluginRequest = createGatewayPluginRequestHandler({
    registry: params.pluginRegistry,
    log: params.logPlugins,
  });

  // 4. 启动 HTTP 服务器 (The Listener)
  // ----------------------------------------------------------------
  // 这里真正创建了 Node.js 的 http.Server 实例，并未其实际绑定端口。
  // createGatewayHttpServer 内部组装了所有路由：
  //   - /api/... (Hooks, Plugins)
  //   - /v1/... (OpenAI Compatible API)
  //   - / (Static Assets / Canvas Host)
  const bindHosts = await resolveGatewayListenHosts(params.bindHost);
  const httpServers: HttpServer[] = [];
  const httpBindHosts: string[] = [];
  for (const host of bindHosts) {
    const httpServer = createGatewayHttpServer({
      canvasHost,
      clients,
      controlUiEnabled: params.controlUiEnabled,
      controlUiBasePath: params.controlUiBasePath,
      controlUiRoot: params.controlUiRoot,
      openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
      openResponsesEnabled: params.openResponsesEnabled,
      openResponsesConfig: params.openResponsesConfig,
      handleHooksRequest,
      handlePluginRequest,
      resolvedAuth: params.resolvedAuth,
      tlsOptions: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
    });
    try {
      await listenGatewayHttpServer({
        httpServer,
        bindHost: host,
        port: params.port,
      });
      httpServers.push(httpServer);
      httpBindHosts.push(host);
    } catch (err) {
      if (host === bindHosts[0]) {
        throw err;
      }
      params.log.warn(
        `gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`,
      );
    }
  }
  const httpServer = httpServers[0];
  if (!httpServer) {
    throw new Error("Gateway HTTP server failed to start");
  }

  // 5. 初始化 WebSocket 服务器
  // ----------------------------------------------------------------
  // 创建 WS 服务，注意 `noServer: true`。
  // 这意味着 WS 服务**不独占**端口，而是通过 HTTP Server 的 `upgrade` 事件共享端口。
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
  });
  // 将 WS 升级处理逻辑挂载到 HTTP Server 上
  // 当 HTTP Server 收到 `Connection: Upgrade` 请求时，转交给 wss 处理。
  for (const server of httpServers) {
    attachGatewayUpgradeHandler({
      httpServer: server,
      wss,
      canvasHost,
      clients,
      resolvedAuth: params.resolvedAuth,
    });
  }

  // 6. 初始化内存状态 (Memory State)
  // ----------------------------------------------------------------
  // 这一大块都在初始化各种 Map 和 Set，用于追踪运行时的动态数据。
  
  // agentRunSeq: Agent 运行序号生成器
  const agentRunSeq = new Map<string, number>();
  // dedupe: 消息去重缓存，防止重复处理同一请求
  const dedupe = new Map<string, DedupeEntry>();
  // chatRunState: 聊天会话状态（正在进行的对话、未发送的增量更新等）
  const chatRunState = createChatRunState();
  const chatRunRegistry = chatRunState.registry;
  const chatRunBuffers = chatRunState.buffers;
  const chatDeltaSentAt = chatRunState.deltaSentAt;
  const addChatRun = chatRunRegistry.add;
  const removeChatRun = chatRunRegistry.remove;
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const toolEventRecipients = createToolEventRecipientRegistry();

  return {
    canvasHost,
    httpServer,
    httpServers,
    httpBindHosts,
    wss,
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    toolEventRecipients,
  };
}
