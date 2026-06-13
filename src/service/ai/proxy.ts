import { Provide, Inject, Config } from '@midwayjs/core';
import { RedisService } from '@midwayjs/redis';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import fetch from 'node-fetch';
import { R } from '../../common/base.error.utils';
import { AiUsageLogEntity } from '../../entity/aiUsageLog';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatContext {
  module: string;
  articleKey?: string;
}

interface AiConfig {
  provider: string;
  apiKey: string;
  model: string;
  rateLimit: {
    freeUserPerHour: number;
    memberPerHour: number;
    windowSeconds: number;
  };
}

const MODULE_PERSONA: Record<string, string> = {
  knowledge: '你是一位专注于前端技术的编程导师，精通 JavaScript、TypeScript、React、Vue、CSS 等前端技术。',
  firstclass: '你是一位职业发展导师，帮助学习者规划前端工程师的学习路径和职业发展。',
  interview: '你是一位有丰富面试经验的技术专家，熟悉各大互联网公司的前端面试题和答题技巧。',
  algorithm: '你是一位算法竞赛教练，善于用循序渐进的方式讲解数据结构和算法题目，会给予提示而不是直接给出答案。',
  fullstack: '你是一位全栈工程师导师，精通 Node.js、数据库设计、API 开发和服务部署。',
  agent: '你是一位 AI Agent 工程师导师，精通 LLM 应用开发、Prompt Engineering、RAG 架构、Agent 框架（LangChain、Vercel AI SDK、MCP）和生产级 AI 系统设计。',
};

const DEFAULT_PERSONA = '你是一位全栈 AI 工程师学习平台的 AI 导师，帮助用户学习前端开发、全栈技术和 AI Agent 工程。';

@Provide()
export class AiProxyService {
  @Config('ai')
  aiConfig: AiConfig;

  @Inject()
  redisService: RedisService;

  @InjectEntityModel(AiUsageLogEntity)
  aiUsageLogModel: Repository<AiUsageLogEntity>;

  async checkRateLimit(userId: string, isMember: boolean): Promise<void> {
    const limit = isMember
      ? this.aiConfig.rateLimit.memberPerHour
      : this.aiConfig.rateLimit.freeUserPerHour;
    const key = `ai:rate:${userId}`;
    const current = await this.redisService.incr(key);
    if (current === 1) {
      await this.redisService.expire(key, this.aiConfig.rateLimit.windowSeconds);
    }
    if (current > limit) {
      throw R.forbiddenError(`AI 请求已达上限（每小时 ${limit} 次），请稍后再试`);
    }
  }

  buildSystemPrompt(context: ChatContext): string {
    const persona = MODULE_PERSONA[context.module] || DEFAULT_PERSONA;
    return `${persona}\n\n请用中文回答，保持回答简洁清晰，代码示例使用 Markdown 格式。`;
  }

  private buildRequestBody(messages: ChatMessage[], systemPrompt: string, streaming: boolean) {
    const allMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    if (this.aiConfig.provider === 'openai') {
      return {
        model: this.aiConfig.model,
        messages: allMessages,
        stream: streaming,
        max_tokens: 2048,
      };
    }

    // Default: DashScope (通义千问)
    const params: Record<string, unknown> = { result_format: 'message' };
    if (streaming) params.incremental_output = true;

    return {
      model: this.aiConfig.model,
      input: { messages: allMessages },
      parameters: params,
    };
  }

  private getRequestConfig(streaming: boolean): { url: string; headers: Record<string, string> } {
    if (this.aiConfig.provider === 'openai') {
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
          'Authorization': `Bearer ${this.aiConfig.apiKey}`,
          'Content-Type': 'application/json',
          ...(streaming ? { 'Accept': 'text/event-stream' } : {}),
        },
      };
    }

    // Default: DashScope
    return {
      url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
      headers: {
        'Authorization': `Bearer ${this.aiConfig.apiKey}`,
        'Content-Type': 'application/json',
        ...(streaming ? { 'Accept': 'text/event-stream' } : {}),
      },
    };
  }

  private extractContent(data: Record<string, unknown>): string {
    if (this.aiConfig.provider === 'openai') {
      const choices = data?.choices as Array<{ message?: { content?: string }; delta?: { content?: string } }>;
      return choices?.[0]?.message?.content || choices?.[0]?.delta?.content || '';
    }
    // DashScope
    const output = data?.output as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
    return output?.choices?.[0]?.message?.content || '';
  }

  private extractStreamContent(data: Record<string, unknown>): { content: string; done: boolean } {
    if (this.aiConfig.provider === 'openai') {
      const choices = data?.choices as Array<{ delta?: { content?: string }; finish_reason?: string }>;
      return {
        content: choices?.[0]?.delta?.content || '',
        done: choices?.[0]?.finish_reason === 'stop',
      };
    }
    // DashScope
    const output = data?.output as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
    return {
      content: output?.choices?.[0]?.message?.content || '',
      done: output?.choices?.[0]?.finish_reason === 'stop',
    };
  }

  private async logUsage(userId: string, module: string, tokenUsed: number): Promise<void> {
    try {
      const log = new AiUsageLogEntity();
      log.userId = userId;
      log.module = module;
      log.tokenUsed = tokenUsed;
      log.provider = this.aiConfig.provider;
      await this.aiUsageLogModel.save(log);
    } catch {
      // Non-critical: don't fail the request if logging fails
    }
  }

  async forward(messages: ChatMessage[], context: ChatContext, userId: string): Promise<string> {
    if (!this.aiConfig.apiKey) throw R.error('AI 服务未配置，请联系管理员');

    const systemPrompt = this.buildSystemPrompt(context);
    const { url, headers } = this.getRequestConfig(false);
    const body = this.buildRequestBody(messages, systemPrompt, false);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw R.error(`AI 服务请求失败 (${response.status})${text ? ': ' + text : ''}`);
    }

    const result = await response.json() as Record<string, unknown>;
    const content = this.extractContent(result);

    const usage = result?.usage as { total_tokens?: number; input_tokens?: number; output_tokens?: number };
    const tokenUsed = usage?.total_tokens || (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
    await this.logUsage(userId, context.module, tokenUsed);

    return content;
  }

  async *forwardStream(
    messages: ChatMessage[],
    context: ChatContext,
    userId: string
  ): AsyncGenerator<string> {
    if (!this.aiConfig.apiKey) throw R.error('AI 服务未配置，请联系管理员');

    const systemPrompt = this.buildSystemPrompt(context);
    const { url, headers } = this.getRequestConfig(true);
    const body = this.buildRequestBody(messages, systemPrompt, true);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw R.error(`AI 服务请求失败 (${response.status})${text ? ': ' + text : ''}`);
    }

    if (!response.body) throw R.error('AI 服务响应异常');

    let totalTokens = 0;
    const decoder = new (require('string_decoder').StringDecoder)('utf8');

    for await (const chunk of response.body) {
      const text = decoder.write(chunk as Buffer);
      const lines = text.split('\n').filter((l: string) => l.startsWith('data:'));

      for (const line of lines) {
        const rawData = line.slice(5).trim();
        if (rawData === '[DONE]') return;

        try {
          const parsed = JSON.parse(rawData) as Record<string, unknown>;
          const { content, done } = this.extractStreamContent(parsed);

          if (content) {
            yield content;
          }

          // Track token usage from final SSE message
          const usage = parsed?.usage as { total_tokens?: number };
          if (usage?.total_tokens) totalTokens = usage.total_tokens;

          if (done) {
            await this.logUsage(userId, context.module, totalTokens);
            return;
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    await this.logUsage(userId, context.module, totalTokens);
  }
}
