import type { ReplyToMode } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.telegram.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramContext, TelegramStreamMode } from "./bot/types.js";
import {
  buildTelegramMessageContext,
  type BuildTelegramMessageContextParams,
  type TelegramMediaRef,
} from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";

/** Dependencies injected once when creating the message processor. */
type TelegramMessageProcessorDeps = Omit<
  BuildTelegramMessageContextParams,
  "primaryCtx" | "allMedia" | "storeAllowFrom" | "options"
> & {
  telegramCfg: TelegramAccountConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  opts: Pick<TelegramBotOptions, "token">;
  resolveBotTopicsEnabled: (ctx: TelegramContext) => boolean | Promise<boolean>;
};

// ------------------------------------------------------------------
// 3. 消息处理器工厂 (Message Processor Factory)
// ------------------------------------------------------------------
export const createTelegramMessageProcessor = (deps: TelegramMessageProcessorDeps) => {
  // 解构所有注入的依赖项，这些依赖项在 `bot.ts` 初始化时被传入。
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    resolveBotTopicsEnabled,
  } = deps;

  // 返回实际的 `processMessage` 函数。
  // 这个函数是一个闭包，它“记住”了上面的所有依赖项。
  return async (
    primaryCtx: TelegramContext,
    allMedia: TelegramMediaRef[],
    storeAllowFrom: string[],
    options?: { messageIdOverride?: string; forceWasMentioned?: boolean },
  ) => {
    // --------------------------------------------------------------
    // 3.1 构建标准化的消息上下文 (Build Context)
    // --------------------------------------------------------------
    // `buildTelegramMessageContext` 是这一步的核心。
    // 它负责：
    // - 将 Telegram 的特定对象 (ctx, msg) 转换为 OpenClaw 内部使用的统一格式。
    // - 解析引用回复 (reply-to)。
    // - 确定消息的发送者、内容、聊天类型。
    // - 检查是否触发了机器人的响应条件（如 @mention）。
    const context = await buildTelegramMessageContext({
      primaryCtx,
      allMedia,
      storeAllowFrom,
      options,
      bot,
      cfg,
      account,
      historyLimit,
      groupHistories,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      ackReactionScope,
      logger,
      resolveGroupActivation,
      resolveGroupRequireMention,
      resolveTelegramGroupConfig,
    });
    
    // 如果上下文构建失败（例如消息应被忽略），则退出。
    if (!context) {
      return;
    }

    // --------------------------------------------------------------
    // 3.2 调用分发器 (Dispatch)
    // --------------------------------------------------------------
    // 上下文构建完成后，将其传递给分发器。
    await dispatchTelegramMessage({
      context,
      bot,
      cfg,
      runtime,
      replyToMode,
      streamMode,
      textLimit,
      telegramCfg,
      opts,
      resolveBotTopicsEnabled,
    });
  };
};
