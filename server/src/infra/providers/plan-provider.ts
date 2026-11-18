import type { PlanResult, PlanStop, RoutePlanner } from '../../domain/ports.ts';
import type { LlmOptions } from './script-provider.ts';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 顺路景点数与坐标合理性区间：只挡明显离谱的输出，不追求精确边界 */
const STOPS_MIN = 3;
const STOPS_MAX = 6;
const TAGS_MAX = 4;
const LAT_MIN = 15;
const LAT_MAX = 140;
const LNG_MIN = 70;
const LNG_MAX = 140;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function planPrompt(wish: string): string {
  return `你是「游览向导」小程序的行程规划助手。根据用户的一句话旅行愿望，规划一条顺路可执行的游览路线。

愿望：${wish}

规则：
1. 从愿望中推断城市；无法确定时默认洛阳；
2. 挑选该城市 ${STOPS_MIN}–${STOPS_MAX} 个真实存在的景点，按顺路可执行的游览顺序排列（同片区相邻、不走回头路），名称用通用全称；
3. 坐标必须是 GCJ-02（火星坐标，小程序地图 gcj02 用），保留 4–6 位小数；
4. tags 为 2–4 个短标签，覆盖天数/城市/主题/节奏这类意图，例如 ["2 天","洛阳","人文古迹","节奏舒缓"]；
5. 愿望若指定了讲述人或同行人物视角（如「让武则天带我们逛」「武则天讲解」「请玄奘当导游」），persona 输出该历史人物的通用姓名（不超过 6 字）；未指定则输出空字符串。persona 只填人物名，不要带「讲述」「导游」等后缀。

只输出 JSON，不要解释，不要 Markdown 代码块。格式：
{
  "tags": ["……", "……"],
  "persona": "武则天",
  "stops": [
    {"name": "白马寺", "lat": 34.7216, "lng": 112.6021}
  ]
}`;
}

/**
 * 防御性解析：剥掉 Markdown 围栏、截取首个 JSON 对象再 parse；
 * 逐条校验景点名与坐标区间，按名去重并压进 3–6 站，不合格直接抛错。
 */
export function parsePlan(content: string): PlanResult {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : trimmed).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const body = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;

  let pool: unknown;
  try {
    pool = JSON.parse(body);
  } catch {
    throw new Error('行程规划失败：模型返回的不是合法 JSON');
  }

  const record = asRecord(pool);
  const tags = Array.isArray(record.tags)
    ? [...new Set(record.tags.map((tag) => text(tag)).filter(Boolean))].slice(0, TAGS_MAX)
    : [];

  const rawStops = Array.isArray(record.stops) ? record.stops : [];
  const seen = new Set<string>();
  const stops: PlanStop[] = [];
  rawStops.forEach((item) => {
    const raw = asRecord(item);
    const name = text(raw.name);
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    if (!name || seen.has(name)) return;
    if (!Number.isFinite(lat) || lat < LAT_MIN || lat > LAT_MAX) return;
    if (!Number.isFinite(lng) || lng < LNG_MIN || lng > LNG_MAX) return;
    seen.add(name);
    stops.push({ name, lat, lng });
  });

  if (stops.length < STOPS_MIN) {
    throw new Error(`行程规划失败：可用景点不足（${stops.length} 个）`);
  }

  const persona = text(record.persona).slice(0, 12);

  return { tags, persona, stops: stops.slice(0, STOPS_MAX) };
}

/** 通义千问（OpenAI 兼容）路线规划：单次调用，输出交给 parsePlan 严格把关 */
export class QwenRoutePlanner implements RoutePlanner {
  private readonly options: LlmOptions;

  constructor(options: LlmOptions) {
    this.options = options;
  }

  async plan(wish: string): Promise<PlanResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是严谨的中文行程规划助手，只输出 JSON。' },
      { role: 'user', content: planPrompt(wish) }
    ];
    const content = await this.request(messages);
    return parsePlan(content);
  }

  private async request(messages: ChatMessage[]): Promise<string> {
    if (!this.options.apiKey) {
      throw new Error('未配置规划服务（缺少 LLM_API_KEY）');
    }

    const res = await fetch(this.options.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + this.options.apiKey
      },
      body: JSON.stringify({
        model: this.options.model,
        messages,
        temperature: 0.6,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        // 与文稿生成一致：非流式调用下默认不开思考
        enable_thinking: this.options.enableThinking === true,
        stream: false
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`规划服务返回 ${res.status}：${detail}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('规划服务返回空内容');
    return content;
  }
}
