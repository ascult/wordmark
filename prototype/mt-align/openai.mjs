/**
 * 原型：OpenAI 兼容接口的最小客户端（用来接本机的 teacher 模型）。
 *
 * 【原型代码，不是生产实现】
 *
 * 只用 Node 自带的 fetch。
 *
 * 注意：跑本机 teacher 时**不要**设 NODE_USE_ENV_PROXY / HTTPS_PROXY，
 * 否则 127.0.0.1 的请求也会被丢给 HTTP 代理然后失败（header 层面绕不过去）。
 * 反过来说，这个脚本不需要访问外网，所以直接不设代理最省事。
 */

export class ChatClient {
  #baseUrl;
  #apiKey;
  #model;
  #temperature;
  #stats = { calls: 0, totalMs: 0, maxMs: 0, failures: 0 };

  #extraBody;

  constructor({ baseUrl = 'http://127.0.0.1:8000', apiKey, model, temperature = 0, extraBody = {} } = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#apiKey = apiKey;
    this.#model = model;
    this.#temperature = temperature;
    // 推理模型默认会把 token 全花在「 Thinking Process」上，答案是空的。
    // Qwen3 系用 chat_template_kwargs.enable_thinking=false 关掉（实测 2427ms → 809ms）。
    this.#extraBody = extraBody;
  }

  get stats() {
    return { ...this.#stats, avgMs: this.#stats.calls === 0 ? 0 : Math.round(this.#stats.totalMs / this.#stats.calls) };
  }

  get model() {
    return this.#model;
  }

  /** 列出服务端模型；用于确认模型 id。 */
  async listModels() {
    const response = await fetch(`${this.#baseUrl}/v1/models`, { headers: this.#headers() });
    if (!response.ok) throw new Error(`列出模型失败 HTTP ${response.status}：${(await response.text()).slice(0, 160)}`);
    const payload = await response.json();
    return (payload.data ?? []).map((item) => item.id);
  }

  async complete({ system, user, maxTokens = 512, timeoutMs = 180_000 }) {
    const started = Date.now();
    const body = {
      model: this.#model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: this.#temperature,
      stream: false,
      ...this.#extraBody,
    };
    let response;
    try {
      response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...this.#headers(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.#stats.failures += 1;
      throw new Error(`请求 teacher 失败：${error.message}`, { cause: error });
    }
    const elapsed = Date.now() - started;
    this.#stats.calls += 1;
    this.#stats.totalMs += elapsed;
    this.#stats.maxMs = Math.max(this.#stats.maxMs, elapsed);
    if (!response.ok) {
      this.#stats.failures += 1;
      throw new Error(`teacher 返回 HTTP ${response.status}：${(await response.text()).slice(0, 200)}`);
    }
    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content ?? '';
    return { text: String(text), elapsedMs: elapsed };
  }

  #headers() {
    return { authorization: `Bearer ${this.#apiKey ?? ''}` };
  }
}
