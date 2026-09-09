/**
 * OpenRouter chat-completions client with tool calling.
 *
 * Mirrors the conventions of `src/vercel.ts`: module constants, a `kind` union
 * plus a typed error, constructor-injected secret, and a private `request()`
 * that never echoes the key.
 */

const API_BASE = 'https://openrouter.ai/api/v1';
const REQUEST_TIMEOUT_MS = 45_000;

export type AiErrorKind =
  | 'unauthorized'
  | 'payment_required'
  | 'rate_limited'
  | 'bad_request'
  | 'network'
  | 'http';

export class AiApiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiApiError';
  }
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** OpenRouter reports the real charge; 0 when it is not returned. */
  costUsd: number;
  /** Prompt tokens served from the provider's cache — the saving, when > 0. */
  cachedTokens: number;
}

export interface CompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: Usage;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  maxTokens: number;
  /** Omitted entirely when undefined, so cheap requests pay no reasoning tokens. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * Mark the leading system message as cacheable. Anthropic models on
   * OpenRouter then charge a fraction for the (static) project context.
   */
  cacheSystemPrompt?: boolean;
}

interface RawResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

export class OpenRouterClient {
  constructor(private readonly apiKey: string) {}

  async chat(options: ChatOptions): Promise<CompletionResult> {
    const messages = options.cacheSystemPrompt
      ? this.withCachedSystemPrompt(options.messages)
      : options.messages;

    // Note: OpenRouter's `usage: { include: true }` flag is deprecated and has no
    // effect — usage (including the real `cost`) is returned on every response.
    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      max_tokens: options.maxTokens,
      temperature: 0.2,
    };
    if (options.tools?.length) {
      body.tools = options.tools;
      body.tool_choice = 'auto';
    }
    if (options.reasoningEffort) {
      body.reasoning = { effort: options.reasoningEffort };
    }

    const data = await this.request<RawResponse>('/chat/completions', body);
    const choice = data.choices?.[0];
    if (!choice?.message) {
      throw new AiApiError('http', data.error?.message || 'Model returned no message');
    }

    return {
      content: choice.message.content ?? null,
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason ?? 'stop',
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        costUsd: data.usage?.cost ?? 0,
        cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }

  /**
   * Anthropic-style cache breakpoint on the system prompt. Other providers
   * ignore the extra field, so this is safe across the whole model list.
   */
  private withCachedSystemPrompt(messages: ChatMessage[]): unknown[] {
    return messages.map((message, index) => {
      if (index !== 0 || message.role !== 'system' || typeof message.content !== 'string') {
        return message;
      }
      return {
        role: 'system',
        content: [
          {
            type: 'text',
            text: message.content,
            cache_control: { type: 'ephemeral' },
          },
        ],
      };
    });
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          // Attribution shown on the OpenRouter dashboard.
          'HTTP-Referer': 'https://vibespot.com',
          'X-Title': 'Viby (Vibespot Telegram bot)',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new AiApiError(
        'network',
        err instanceof Error && err.name === 'AbortError'
          ? 'The model took too long to answer'
          : 'Could not reach OpenRouter',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) throw await this.toApiError(res);
    try {
      return (await res.json()) as T;
    } catch {
      throw new AiApiError('http', 'OpenRouter returned a non-JSON response', res.status);
    }
  }

  private async toApiError(res: Response): Promise<AiApiError> {
    let serverMessage = '';
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      serverMessage = body.error?.message ?? '';
    } catch {
      /* ignore non-JSON bodies */
    }
    switch (res.status) {
      case 401:
        return new AiApiError('unauthorized', 'OpenRouter key is invalid or expired', 401);
      case 402:
        return new AiApiError('payment_required', 'OpenRouter credits exhausted', 402);
      case 400:
        return new AiApiError('bad_request', serverMessage || 'OpenRouter rejected the request', 400);
      case 429:
        return new AiApiError('rate_limited', 'OpenRouter rate limit reached', 429);
      default:
        return new AiApiError('http', `OpenRouter error (HTTP ${res.status})`, res.status);
    }
  }
}
