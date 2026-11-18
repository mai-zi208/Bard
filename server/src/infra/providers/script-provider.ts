import type {
  GenerationInput,
  MasterSource,
  PackOutline,
  ResearchMaterial,
  SceneOutline,
  SceneScript,
  ScriptResult,
  ScriptWriter
} from '../../domain/ports.ts';
import { variantId } from '../../domain/services/persona.ts';

export interface LlmOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 千问混合思考模型是否开启思考；关闭时思考内容不占 max_tokens */
  enableThinking?: boolean;
  timeoutMs: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const TRANSITIONS = ['zoom-out', 'rise', 'slide', 'fade'];
/** 分幕撰稿并发路数：每幕一次调用，5–8 幕可一轮跑完 */
const SCRIPT_WORKERS = 6;
const MATERIAL_LIMIT = 9000;
/** 未配置幕数上限时的硬上限，与 tools/validate-pack.js 的 SCENE_MAX 保持一致 */
const SCENE_LIMIT_MAX = 40;

/** 通用文稿格式：每幕 2 屏 × 2 块，字数含标点 */
const BLOCKS_PER_SCENE = 4;
const BLOCK_MIN = 30;
const BLOCK_MAX = 48;
const SCREEN_MIN = 70;
const SCREEN_MAX = 90;
const SCENE_MIN = 150;
const SCENE_MAX = 170;
/** 首轮字数不达标时的放宽区间：块 25–50，屏 60–100，幕 140–180 */
const RELAXED_BLOCK_MIN = 25;
const RELAXED_BLOCK_MAX = 50;
const RELAXED_SCREEN_MIN = 60;
const RELAXED_SCREEN_MAX = 100;
const RELAXED_SCENE_MIN = 140;
const RELAXED_SCENE_MAX = 180;

/** 字数不达标：重试时自动放宽区间，其他校验失败仍按原规则重写 */
export class ScriptLengthError extends Error {}

/** 重写提示里的格式要求，按当前是否放宽取对应区间 */
function lengthRule(relaxed: boolean): string {
  const blockMin = relaxed ? RELAXED_BLOCK_MIN : BLOCK_MIN;
  const blockMax = relaxed ? RELAXED_BLOCK_MAX : BLOCK_MAX;
  const screenMin = relaxed ? RELAXED_SCREEN_MIN : SCREEN_MIN;
  const screenMax = relaxed ? RELAXED_SCREEN_MAX : SCREEN_MAX;
  const sceneMin = relaxed ? RELAXED_SCENE_MIN : SCENE_MIN;
  const sceneMax = relaxed ? RELAXED_SCENE_MAX : SCENE_MAX;
  return `每幕 ${BLOCKS_PER_SCENE} 块、块间空一行、单块 ${blockMin}–${blockMax} 字、同屏两块合计 ${screenMin}–${screenMax} 字、全幕 ${sceneMin}–${sceneMax} 字`;
}

function countChars(value: string): number {
  return value.replace(/\s/g, '').length;
}

/** 尺寸数据：只描述体量的「多少米」类写法（含中文数字与「平米」简写） */
const SIZE_RE = /(?:[0-9０-９]+(?:\.[0-9]+)?|[一二三四五六七八九十百千两零]+)(?:余|多|近)?(?:点[零一二三四五六七八九]+)?(?:平方米|平米|厘米|毫米|米|吨|公斤)/;
/** 数量量词：同块出现两处以上视为清单式罗列 */
const COUNT_RE = /(?:[0-9０-９]+(?:\.[0-9]+)?|[一二三四五六七八九十百千万两零]+)(?:余|多)?(?:尊|块|种|例|座|件|卷|幅|通|个|处|人)/g;
/** 套语与营销词（含「之最」类最高级表述） */
const CLICHE_RE =
  /巍峨|庄严|精美|震撼|叹为观止|美轮美奂|气势恢宏|雄伟壮观|世界文化遗产|规模最大|体量最大|世界之最|史上最大|世界第一|艺术宝库|必打卡|令人神往/;
/** 「X，比 Y 还 Z」句式 */
const SIMILE_RE = /比[^。，；]{1,8}还/g;

/**
 * 质量复核：只查能机械判断的硬伤——尺寸数据、数量清单、套语、比喻超配额。
 * 命中返回可读问题清单，供回炉提示使用；不回炉时仅告警，不阻断发布。
 */
export function qualityIssues(result: ScriptResult): string[] {
  const issues: string[] = [];
  let similes = 0;

  result.scenes.forEach((scene) => {
    scene.body.split('\n\n').forEach((block, index) => {
      const size = block.match(SIZE_RE);
      if (size) {
        issues.push(`「${scene.id}」第 ${index + 1} 块写了尺寸「${size[0]}」，改成谁在这里做过什么`);
      }
      const counts = block.match(COUNT_RE) || [];
      if (counts.length >= 2) {
        issues.push(
          `「${scene.id}」第 ${index + 1} 块罗列数量（${counts.join('、')}），只留与叙事相关的一处`
        );
      }
      const cliche = block.match(CLICHE_RE);
      if (cliche) {
        issues.push(`「${scene.id}」第 ${index + 1} 块用了套语「${cliche[0]}」，换成具体细节`);
      }
      similes += (block.match(SIMILE_RE) || []).length;
    });
  });

  if (similes > 1) issues.push(`全包「比…还…」句式出现 ${similes} 次，最多保留一次`);
  return issues;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 整包文案字段钳制：模型偶发超 1–2 字时截到上限，优先在句读处断句，避免装配校验把整包打回 */
function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastPunct = cut.search(/[。，；、！？][^。，；、！？]*$/);
  return lastPunct > 10 ? cut.slice(0, lastPunct + 1) : cut;
}

function slug(value: unknown, fallback: string): string {
  const cleaned = text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : trimmed).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const body = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  return JSON.parse(body);
}

function narratorLine(persona: string): string {
  return persona ? persona : '现代导游';
}

function outlinePrompt(input: GenerationInput, material: ResearchMaterial, sceneLimit: number): string {
  const sceneRange = sceneLimit > 0 ? `5–${sceneLimit}` : '5 个以上（按实际可讲的实体数量，不凑数）';
  return `你是「游览向导」小程序的资深内容策划，要把一处景物拆成可以逐幕游览的分镜。

主题：${input.topic}
讲述人：${narratorLine(input.persona)}

可使用的资料（只允许使用这里出现的事实，不得补充资料以外的记忆和传闻）：
${material.text.slice(0, MATERIAL_LIMIT)}

请完成两件事：
1. 按真实游览路线（由外到内、由南到北）列出 ${sceneRange} 个可以讲的实体，一物一幕。殿、窟、碑、塔、井、树、遗址都算；不得为凑数丢弃主要景物，也不得虚构；资料中与讲述人直接相关的实体或事件优先排进清单；
2. 首幕交代位置与来历，末幕落在最有分量的实体上。

每幕字段要求：
- title：2–4 字；
- subtitle：4–8 字，不与 title 重复，不写尺寸数字，不用「最大/最高/之最」这类最高级表述；
- pose：不超过 20 字，写讲述人站在这一处做的动作，动作要贴合本幕景物（如「登上城楼，扶垛远眺」「在殿上凭几听政」「沿御道缓步前行」），只写动作与姿态，不写景物描述；讲述人是现代导游时写「站在景前讲解，侧身指点」这类动作；
- brief：1–2 句话，写这一幕能讲成故事的「人事」：谁在这里做了什么、为什么；不要写成数据摘要，最多带一个关键数字；
- imageAlt：不超过 40 字，写这一幕配图里应当出现的画面主体（如「山门与门前石马」「大殿正立面与月台」），只写看得见的实体与环境，不写尺寸、不写文字与水印；
- id：全小写拼音，只允许 a-z、0-9 和连字符。

配图会按 imageAlt 先出图，文稿随后照着图写，所以 imageAlt 要选主体明确、能画出来的那种画面。

整包字段：
- id：景物的通用拼音短名，如 guanlin；
- title：不超过 20 字；
- subtitle：不超过 30 字；
- summary：不超过 60 字；title、subtitle、summary 一律不写尺寸数字，不用「世界最大/体量最大/世界之最」这类最高级营销语；
- tags：2–5 个短标签。

如果资料不足以支撑 5 幕，不要硬编，输出 {"error":"资料不足"}。
只输出 JSON，不要解释，不要 Markdown。格式：
{
  "id": "guanlin",
  "title": "洛阳关林",
  "subtitle": "……",
  "summary": "……",
  "tags": ["……", "……"],
  "scenes": [
    {"id": "……", "title": "……", "subtitle": "……", "pose": "……", "brief": "……", "imageAlt": "……"}
  ]
}`;
}

/** 讲述人规则：有讲述人时只在与本人强相关的幕用第一人称 */
function personaLine(input: GenerationInput): string {
  return input.persona
    ? `讲述人是「${input.persona}」。只有与${input.persona}有明确历史关联的幕，才允许用本人视角（如「朕」）写主观块；其余幕一律客观叙述，或引用有出处的他人说法。存疑、相传的说法不写。`
    : '讲述人是现代导游，用现代口语客观讲述，不冒充历史人物。';
}

/** 所有幕共用的写作规范：两个参照只学写法，不照搬内容 */
function writingRules(): string {
  return `- 正文固定 ${BLOCKS_PER_SCENE} 块（即「2 屏 × 2 块」），块与块之间空一行；单块 ${BLOCK_MIN}–${BLOCK_MAX} 字，按每块 38–42 字控制，同一屏两块合计 ${SCREEN_MIN}–${SCREEN_MAX} 字，全幕必须写满 ${SCENE_MIN}–${SCENE_MAX} 字（字数含标点），按 4 块 × 40 字 ≈ 160 字来写；字数不足就是不合格，第 2、3 块的人事各多写一句，不要用套语凑字；
- ${BLOCKS_PER_SCENE} 块按「站位与实物 → 来历或象征 → 一条人事 → 短点评或关键事实」推进，每块只讲一件事；第 2、3 块至少一块写「人事」（谁在这里做了什么、为什么）；
- 第 1 块第一句就落到本幕看得见的东西：可以是独立地标（殿、塔、石坊、造像、碑），也可以是这一处的整体环境；不得从地理概况、「XX 是……」定义句或「规模最大」这类概括起笔；
- 正文不点名冷僻的小构件（某座小台、某块匾、某个檐角）：这类细节用「眼前」「这一带」「台上」等泛称带过，把可指认的主体留给配图；
- 不写尺寸（高、宽、进深、通高多少米，含「近百米」「三百一十二米」「两千平米」这类中文数字写法）与数量清单（多少尊、多少块、多少种、多少例、多少个）；年代、门洞数、人数这类支撑叙事的数字可以写，同一件事的一组数字算一处，每块至多一处；能写「谁做了什么」就不要写「现存多少、高多少」；
- 不写「世界之最」「规模最大」「体量最大」「史上最大」「世界第一」这类最高级营销语，即使资料里有也不引用；建筑的壮观交给「谁在这里做过什么」和参观者的反应去写，不交给数字与头衔；
- 全包「X，比 Y 还 Z」这类比喻最多出现一次，且不得连续两幕用比喻收尾；
- 客观约八成、主观约两成：主观最多一块；
- 不写建筑形制术语（歇山、悬山、硬山、斗拱铺作）、不写历代重建年份；年代写成中文读法（「公元六十八年」「民国二十四年」）；
- 每幕至少一条可核验事实，数字必须来自资料，不得估算或凑整；
- 每块至少一句不超过 10 字；避免「巍峨」「庄严」「精美」「震撼」「令人叹为观止」这类套语；不写三项排比，不写「不仅…而且」；
- 不使用第二人称说教；同一包内不得连续两幕用同一种开头或收尾；
- 专有名词首次出现给全称；
- 正文只写纯文本段落，不要写标题、列表、加粗或图片。

两个参照，只学写法，不要照搬内容：
正例（白马寺山门幕原文，四块共 168 字：站位与实物 → 象征 → 人事与传说辨析 → 关键事实）：
“这里是白马寺的山门。正中的「白马寺」匾，由中国佛教协会原会长赵朴初题写。”
“山门开三个门洞，象征佛教的「三解脱门」：空门、无相门、无愿门。跨过这道门，就是把执念放下。”
“山门前那两匹石马，传说是汉代驮经之马。其实是北宋太师魏咸信墓前的石像，民国二十四年被移到寺前。”
“白马寺始建于东汉永平十一年，公元六十八年，是佛教传入中国后兴建的第一座官办寺院。”
反例（不要这样写）：「九尊大像依山凿石而成，山崖本身就是佛殿。这是龙门石窟中规模最大的一组摩崖群雕。居中的卢舍那大佛高达十七米多，仅头部就有四米。耳长一点九米，比人还高。」——通篇尺度与数字，没有一个人在这里做过什么。
反例（不要这样写）：「原高近百米，是世界历史上体量最大的木质建筑，曾是世界之最。」——尺寸、头衔全是要禁的东西，换成「武则天在这里接见各国使臣，殿前站满了人」这样的写法。`;
}

/**
 * 单幕撰写提示：每幕一次独立调用，只共享大纲与其他幕标题，
 * 便于 6 路并发把整包文稿压进一次往返的时间。
 */
function sceneScriptPrompt(
  input: GenerationInput,
  material: ResearchMaterial,
  outline: PackOutline,
  scene: SceneOutline,
  index: number
): string {
  const sceneList = outline.scenes
    .map(
      (item, i) =>
        `${i + 1}. ${item.id}｜${item.title}｜${item.subtitle}｜${item.brief}` +
        (i === index ? '　← 本次只写这一幕' : '')
    )
    .join('\n');
  const transition = TRANSITIONS[index % TRANSITIONS.length];

  return `你是「游览向导」小程序的分镜撰稿人。整包共 ${outline.scenes.length} 幕，本次只写第 ${index + 1} 幕的正文。

主题：${input.topic}
${personaLine(input)}

整包幕清单（只用来避免与相邻幕选题重复、开头句式雷同）：
${sceneList}

本次要写的幕：${scene.title}（${scene.subtitle}）
本幕要点：${scene.brief}

可使用的资料（事实与数字只能来自这里）：
${material.text.slice(0, MATERIAL_LIMIT)}

本幕正文要求：
${writingRules()}

配图（imageAlt）：按本幕正文指认的主体写，不超过 40 字，写成「地名 + 本幕所在的主体建筑或那片区域 + 主体在画面里的样子」；不写尺寸、文字与水印；正文讲大殿就不能只画二殿。

转场固定用 ${transition}，holdMs 取 9000；sources 写本幕用到的出处短句，注明资料名。

只输出 JSON，不要解释，不要 Markdown 代码块。格式：
{
  "scenes": [
    {
      "id": "${scene.id}",
      "body": "第一块……\\n\\n第二块……\\n\\n第三块……\\n\\n第四块……",
      "imageAlt": "按本幕正文写的主体画面",
      "transition": "${transition}",
      "holdMs": 9000,
      "sources": ["……"]
    }
  ]
}`;
}

/** 把上一版正文的块字数读成可读反馈，供补字提示使用 */
function blockCountSummary(pool: unknown): string {
  const record = asRecord(pool);
  const rawScenes = Array.isArray(record.scenes) ? record.scenes : [];
  const rawBody = asRecord(rawScenes[0] ?? {}).body;
  const raw = Array.isArray(rawBody)
    ? rawBody.map((part) => text(part)).filter(Boolean).join('\n\n')
    : text(rawBody);
  const blocks = raw
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!blocks.length) return '';
  const counts = blocks.map(countChars);
  return `当前 ${blocks.length} 块分别 ${counts.join('、')} 字（合计 ${counts.reduce(
    (sum, item) => sum + item,
    0
  )} 字）`;
}

function rewritePrompt(input: GenerationInput, master: MasterSource): string {
  const scenes = master.scenes.map((scene) => ({
    id: scene.id,
    title: scene.title,
    subtitle: scene.subtitle,
    body: scene.body || scene.narration
  }));

  return `你在为一处景物制作「人物变体」讲解包。母本由现代导游讲解，现在改由「${input.persona}」讲述。

主题：${master.title}

改写规则：
- 事实、年代、数字、专名与母本完全一致，不得新增母本里没有的史实，也不得删掉母本的关键信息；
- 只改口吻与讲述视角：只有与${input.persona}有明确历史关联的幕，才允许用本人视角（如「朕」）；其余幕保持客观叙述，或引用有出处的他人说法；存疑、相传的说法不写；
- 每一幕 body 固定 ${BLOCKS_PER_SCENE} 块（2 屏 × 2 块），块间空一行；单块 ${BLOCK_MIN}–${BLOCK_MAX} 字、同屏两块合计 ${SCREEN_MIN}–${SCREEN_MAX} 字、全幕 ${SCENE_MIN}–${SCENE_MAX} 字（含标点）；不写尺寸、形制术语与重建年份；
- 保持母本的四块职责（站位与实物 → 来历或象征 → 人事 → 短点评或关键事实），不得改成资料卡；不得把数量、尺寸清单带进来；与讲述人有关的幕，在母本已有事实范围内，把本人与这处实物、事件的关系写进第 2 或第 3 块；
- transition 在 zoom-out / rise / slide / fade 中轮换，相邻幕不要重复；holdMs 取 8000–10000；
- 只输出 JSON，不要解释，不要 Markdown 代码块。

母本各幕：
${JSON.stringify(scenes, null, 2)}

输出格式：
{
  "scenes": [
    {
      "id": "与母本完全一致的 id",
      "body": "第一段……\\n\\n第二段……\\n\\n第三段……\\n\\n第四段……",
      "transition": "fade",
      "holdMs": 9000
    }
  ]
}`;
}

/** 通义千问（OpenAI 兼容）文稿生成：大纲与文稿各一次调用，JSON 解析失败重试一次 */
export class QwenScriptWriter implements ScriptWriter {
  private readonly options: LlmOptions;

  constructor(options: LlmOptions) {
    this.options = options;
  }

  async outline(
    input: GenerationInput,
    material: ResearchMaterial,
    sceneLimit: number
  ): Promise<PackOutline> {
    const messages: ChatMessage[] = [
      { role: 'system', content: '你是严谨的人文景点内容策划，只输出 JSON。' },
      { role: 'user', content: outlinePrompt(input, material, sceneLimit) }
    ];

    let pool = await this.chatJson(messages);
    throwIfInsufficient(pool);
    let outline = normalizeOutline(pool, input.topic);

    const maxScenes = sceneLimit > 0 ? sceneLimit : SCENE_LIMIT_MAX;
    if (outline.scenes.length < 5 || outline.scenes.length > maxScenes) {
      const retry = await this.chatJson([
        ...messages,
        { role: 'assistant', content: JSON.stringify(pool) },
        {
          role: 'user',
          content: `幕数必须在 5–${maxScenes} 之间，当前是 ${outline.scenes.length} 幕。请合并同类的小物件，保留主要实体，重新输出完整 JSON。`
        }
      ]);
      throwIfInsufficient(retry);
      outline = normalizeOutline(retry, input.topic);
    }

    if (outline.scenes.length < 5 || outline.scenes.length > maxScenes) {
      throw new Error(`大纲幕数不符合要求：${outline.scenes.length} 幕`);
    }

    return outline;
  }

  async scripts(
    input: GenerationInput,
    material: ResearchMaterial,
    outline: PackOutline
  ): Promise<ScriptResult> {
    // 每幕独立一次调用，6 路并发；单幕耗时约等于整包一次往返，整包文稿不再线性叠加
    const scenes: SceneScript[] = new Array(outline.scenes.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= outline.scenes.length) return;
        scenes[index] = await this.writeScene(input, material, outline, outline.scenes[index], index);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(SCRIPT_WORKERS, outline.scenes.length) }, () => worker())
    );

    return this.reviseScenes(input, material, outline, { scenes });
  }

  /** 人物变体：不重新检索，以母本正文为事实底稿改写口吻与视角 */
  async rewrite(input: GenerationInput, master: MasterSource): Promise<ScriptResult> {
    const outline: PackOutline = {
      id: variantId(master.id, input.persona),
      title: master.title,
      subtitle: master.subtitle,
      summary: master.summary,
      tags: master.tags,
      scenes: master.scenes.map((scene) => ({
        id: scene.id,
        title: scene.title,
        subtitle: scene.subtitle,
        imageAlt: scene.imageAlt,
        pose: scene.pose,
        brief: '',
        imageQuery: ''
      }))
    };

    const messages: ChatMessage[] = [
      { role: 'system', content: '你是严谨的中文分镜撰稿人，只输出 JSON。' },
      { role: 'user', content: rewritePrompt(input, master) }
    ];
    const pool = await this.chatJson(messages);
    return this.complete(messages, pool, outline, '事实与数字只能来自母本');
  }

  /** 单幕撰稿：字数不达标放宽一次，结构不符重写一次；仍不达标的字数只告警，不阻断整包 */
  private async writeScene(
    input: GenerationInput,
    material: ResearchMaterial,
    outline: PackOutline,
    scene: SceneOutline,
    index: number
  ): Promise<SceneScript> {
    const messages = this.sceneMessages(input, material, outline, scene, index);
    const pool = await this.chatJson(messages);
    const single: PackOutline = { ...outline, scenes: [scene] };

    try {
      return this.takeScene(pool, single, index);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const relaxed = error instanceof ScriptLengthError;
      console.warn(`[生成] 第「${scene.title}」幕${relaxed ? '字数' : '结构'}不符，重写一次：${reason}`);
      const retry = await this.chatJson([
        ...messages,
        { role: 'assistant', content: JSON.stringify(pool) },
        {
          role: 'user',
          content: `上一版未通过校验：${reason}。请重写这一幕，严格满足：${lengthRule(
            relaxed
          )}；${BLOCKS_PER_SCENE} 块、块间空一行，第 1 块落到本幕看得见的东西，不写尺寸与数量清单。只输出 JSON：{"scenes":[{"id":"${
            scene.id
          }","body":"…","imageAlt":"…","transition":"${TRANSITIONS[index % TRANSITIONS.length]}","holdMs":9000}]}`
        }
      ]);
      try {
        return this.takeScene(retry, single, index, relaxed);
      } catch (inner) {
        if (!(inner instanceof ScriptLengthError)) throw inner;
        // 字数仍不够：把逐块字数摊开，再给一次明确的补字机会
        console.warn(`[生成] 第「${scene.title}」幕字数仍不达规范，补写一次：` + inner.message);
        const last = await this.chatJson([
          ...messages,
          { role: 'assistant', content: JSON.stringify(retry) },
          {
            role: 'user',
            content: `${blockCountSummary(retry)}，明显偏短。请逐块扩写这一幕：单块 ${RELAXED_BLOCK_MIN}–${RELAXED_BLOCK_MAX} 字、同一屏两块合计 ${RELAXED_SCREEN_MIN}–${RELAXED_SCREEN_MAX} 字、全幕 ${RELAXED_SCENE_MIN}–${RELAXED_SCENE_MAX} 字；补的内容必须来自资料中与「${scene.title}」相关的人事与细节，写清谁、何时、做了什么，不要用尺寸、数量清单或套语凑字。只输出 JSON：{"scenes":[{"id":"${scene.id}","body":"…","imageAlt":"…","transition":"${TRANSITIONS[index % TRANSITIONS.length]}","holdMs":9000}]}`
          }
        ]);
        try {
          return this.takeScene(last, single, index, true);
        } catch (finalError) {
          if (finalError instanceof ScriptLengthError) {
            console.warn(`[生成] 第「${scene.title}」幕字数仍不达规范，按实际输出继续：` + finalError.message);
            return this.takeScene(last, single, index, true, true);
          }
          throw finalError;
        }
      }
    }
  }

  private sceneMessages(
    input: GenerationInput,
    material: ResearchMaterial,
    outline: PackOutline,
    scene: SceneOutline,
    index: number
  ): ChatMessage[] {
    return [
      { role: 'system', content: '你是严谨的中文分镜撰稿人，只输出 JSON。' },
      { role: 'user', content: sceneScriptPrompt(input, material, outline, scene, index) }
    ];
  }

  /** 取出单幕并固定转场，按幕序轮换保证相邻幕不重复 */
  private takeScene(
    pool: unknown,
    outline: PackOutline,
    index: number,
    relaxed = false,
    warnOnly = false
  ): SceneScript {
    const script = normalizeScripts(pool, outline, relaxed, warnOnly).scenes[0];
    script.transition = TRANSITIONS[index % TRANSITIONS.length];
    return script;
  }

  /**
   * 质量复核：只把命中的幕单独回炉一次，其余幕原样保留；
   * 回炉失败或仍不达标只记警告，不阻断发布。
   */
  private async reviseScenes(
    input: GenerationInput,
    material: ResearchMaterial,
    outline: PackOutline,
    result: ScriptResult
  ): Promise<ScriptResult> {
    const issues = qualityIssues(result);
    if (!issues.length) return result;

    // 问题按幕归类：带「sceneId」前缀的直接归属该幕，全局句式问题归属所有命中的幕
    const byScene = new Map<string, string[]>();
    const known = new Set(result.scenes.map((scene) => scene.id));
    const attach = (id: string, issue: string): void => {
      const list = byScene.get(id) ?? [];
      list.push(issue);
      byScene.set(id, list);
    };

    issues.forEach((issue) => {
      const match = issue.match(/^「([^」]+)」/);
      if (match && known.has(match[1])) {
        attach(match[1], issue);
        return;
      }
      if (issue.includes('比…还…')) {
        result.scenes.forEach((scene) => {
          if ((scene.body.match(SIMILE_RE) || []).length) attach(scene.id, issue);
        });
      }
    });

    const targets = outline.scenes.filter((scene) => byScene.has(scene.id));
    if (!targets.length) return result;

    console.warn('[生成] 文稿质量问题，回炉问题幕（' + targets.map((scene) => scene.id).join('、') + '）：' + issues.join('；'));

    const patch = new Map<string, SceneScript>();
    await Promise.all(
      targets.map(async (scene) => {
        const index = outline.scenes.indexOf(scene);
        const current = result.scenes.find((item) => item.id === scene.id);
        if (!current) return;
        const list = byScene.get(scene.id) ?? [];
        try {
          const retry = await this.chatJson([
            ...this.sceneMessages(input, material, outline, scene, index),
            {
              role: 'assistant',
              content: JSON.stringify({
                scenes: [{ id: current.id, body: current.body, transition: current.transition, holdMs: current.holdMs }]
              })
            },
            {
              role: 'user',
              content: `这一幕有以下问题：\n${list
                .join('\n')}\n请重写这一幕，${lengthRule(
                false
              )}；每块只讲一件事，第 2、3 块至少一块写「谁在这里做了什么」；不写尺寸与数量清单，套语和「比…还…」句式按规范控制。只输出 JSON：{"scenes":[{"id":"${
                scene.id
              }","body":"…","imageAlt":"…","transition":"${TRANSITIONS[index % TRANSITIONS.length]}","holdMs":9000}]}`
            }
          ]);
          try {
            patch.set(scene.id, this.takeScene(retry, { ...outline, scenes: [scene] }, index));
          } catch (lengthError) {
            // 质量回炉优先于字数：重写稿结构合格但字数略偏时按放宽档收下，
            // 否则旧稿的尺寸/套语问题会因「保留原稿」原样发布
            if (!(lengthError instanceof ScriptLengthError)) throw lengthError;
            patch.set(scene.id, this.takeScene(retry, { ...outline, scenes: [scene] }, index, true, true));
            console.warn(
              `[生成] 第「${scene.title}」幕回炉稿字数略偏，按放宽档收下：` + lengthError.message
            );
          }
        } catch (error) {
          console.warn(
            `[生成] 第「${scene.title}」幕回炉失败，保留原稿：` +
              (error instanceof Error ? error.message : String(error))
          );
        }
      })
    );

    if (!patch.size) return result;
    const merged: ScriptResult = { scenes: result.scenes.map((scene) => patch.get(scene.id) ?? scene) };
    const left = qualityIssues(merged);
    if (left.length) console.warn('[生成] 回炉后仍有质量问题，按实际输出继续：' + left.join('；'));
    return merged;
  }

  /** 校验 → 失败重写（字数不达标只重写不达标幕）→ 质量复核回炉一次 */
  private async complete(
    messages: ChatMessage[],
    pool: unknown,
    outline: PackOutline,
    factRule: string
  ): Promise<ScriptResult> {
    let result: ScriptResult;
    try {
      result = normalizeScripts(pool, outline);
    } catch (error) {
      // 字数不达标：只把有问题的幕回炉，避免整包重写把耗时翻倍
      if (error instanceof ScriptLengthError) {
        try {
          const repaired = await this.repairLength(messages, pool, outline, factRule);
          return this.reviseIfRough(messages, repaired, outline, factRule);
        } catch (inner) {
          console.warn(
            '[生成] 局部重写未完成，改为整包重写：' +
              (inner instanceof Error ? inner.message : String(inner))
          );
        }
      }
      // 结构问题（缺幕、块数不对）仍整包重写；字数问题自动放宽到宽松区间
      const relaxed = error instanceof ScriptLengthError;
      const reason = error instanceof Error ? error.message : String(error);
      const retry = await this.chatJson([
        ...messages,
        { role: 'assistant', content: JSON.stringify(pool) },
        {
          role: 'user',
          content: `上一版未通过校验：${reason}。请重写全部幕，严格满足：${lengthRule(relaxed)}；${factRule}。只输出 JSON。`
        }
      ]);
      result = this.settleScript(retry, outline, relaxed);
    }
    return this.reviseIfRough(messages, result, outline, factRule);
  }

  /**
   * 只重写字数不达标的幕：把原稿当底稿点名回炉，其余幕原样拼回。
   * 回炉结果缺幕或结构不对时保留原稿，宁可字数略偏也不整包重来。
   */
  private async repairLength(
    messages: ChatMessage[],
    pool: unknown,
    outline: PackOutline,
    factRule: string
  ): Promise<ScriptResult> {
    // 先按宽松档收下整包原稿：严格档只报第一条问题，这里要逐幕定位
    const base = normalizeScripts(pool, outline, true, true, () => {});
    const failures: { id: string; title: string; reason: string }[] = [];

    outline.scenes.forEach((scene) => {
      const current = base.scenes.find((item) => item.id === scene.id);
      if (!current) return;
      try {
        normalizeScripts({ scenes: [current] }, { ...outline, scenes: [scene] }, false, false, () => {});
      } catch (error) {
        if (!(error instanceof ScriptLengthError)) throw error;
        failures.push({ id: scene.id, title: scene.title, reason: error.message });
      }
    });

    if (!failures.length) return base;

    const retry = await this.chatJson([
      ...messages,
      {
        role: 'assistant',
        content: JSON.stringify({
          scenes: base.scenes.map(({ id, body, transition, holdMs }) => ({ id, body, transition, holdMs }))
        })
      },
      {
        role: 'user',
        content: `上一版只有下面这些幕字数不达标：\n${failures
          .map((item) => '- ' + item.reason)
          .join('\n')}\n请只重写这几幕（id：${failures
          .map((item) => item.id)
          .join('、')}），其余幕不要再输出。严格满足：${lengthRule(true)}；${factRule}。只输出 JSON：{"scenes":[{"id":"…","body":"…","transition":"…","holdMs":9000}]}`
      }
    ]);

    const patch = new Map<string, SceneScript>();
    try {
      const fixed = normalizeScripts(
        retry,
        { ...outline, scenes: outline.scenes.filter((scene) => failures.some((item) => item.id === scene.id)) },
        true,
        true,
        () => {}
      );
      fixed.scenes.forEach((scene) => patch.set(scene.id, scene));
    } catch (error) {
      console.warn(
        '[生成] 局部重写结果不可用，保留原稿：' + (error instanceof Error ? error.message : String(error))
      );
    }

    return normalizeScripts(
      { scenes: base.scenes.map((scene) => patch.get(scene.id) ?? scene) },
      outline,
      true,
      true
    );
  }

  /**
   * 质量复核：命中尺寸、数量清单、套语或比喻超配额时回炉一次。
   * 只把命中的幕送回重写，其余幕原样保留；回炉失败或仍不达标都沿用当前版本，只记警告，不阻断发布。
   */
  private async reviseIfRough(
    messages: ChatMessage[],
    result: ScriptResult,
    outline: PackOutline,
    factRule: string
  ): Promise<ScriptResult> {
    const issues = qualityIssues(result);
    if (!issues.length) return result;

    // 问题按幕归类：带「sceneId」前缀的直接归属该幕，全局句式问题归属所有命中的幕
    const byScene = new Map<string, string[]>();
    const known = new Set(result.scenes.map((scene) => scene.id));
    const attach = (id: string, issue: string): void => {
      const list = byScene.get(id) ?? [];
      list.push(issue);
      byScene.set(id, list);
    };

    issues.forEach((issue) => {
      const match = issue.match(/^「([^」]+)」/);
      if (match && known.has(match[1])) {
        attach(match[1], issue);
        return;
      }
      if (issue.includes('比…还…')) {
        result.scenes.forEach((scene) => {
          if ((scene.body.match(SIMILE_RE) || []).length) attach(scene.id, issue);
        });
      }
    });

    const targets = outline.scenes.filter((scene) => byScene.has(scene.id));
    if (!targets.length) return result;

    const targetIds = targets.map((scene) => scene.id);
    console.warn('[生成] 文稿质量问题，回炉问题幕（' + targetIds.join('、') + '）：' + issues.join('；'));
    try {
      const retry = await this.chatJson([
        ...messages,
        {
          role: 'assistant',
          content: JSON.stringify({
            scenes: result.scenes
              .filter((scene) => byScene.has(scene.id))
              .map(({ id, body, transition, holdMs }) => ({ id, body, transition, holdMs }))
          })
        },
        {
          role: 'user',
          content: `上一版只有下面这些幕有问题：\n${[...byScene.entries()]
            .flatMap(([id, list]) => list.map((issue) => '- ' + (issue.startsWith('「') ? issue : `「${id}」` + issue)))
            .join('\n')}\n请只重写这些幕（id：${targetIds.join(
            '、'
          )}），其余幕不要再输出。按同样格式：${lengthRule(false)}；每块只讲一件事，第 2、3 块至少一块写「谁在这里做了什么」；不写尺寸与数量清单，套语和「比…还…」句式按规范控制；${factRule}。只输出 JSON：{"scenes":[{"id":"…","body":"…","transition":"…","holdMs":9000}]}`
        }
      ]);

      const patch = new Map<string, SceneScript>();
      try {
        const fixed = normalizeScripts(retry, { ...outline, scenes: targets }, true, true, () => {});
        fixed.scenes.forEach((scene) => patch.set(scene.id, scene));
      } catch (error) {
        console.warn(
          '[生成] 问题幕重写结果不可用，保留原稿：' + (error instanceof Error ? error.message : String(error))
        );
      }
      if (!patch.size) return result;

      const merged = normalizeScripts(
        { scenes: result.scenes.map((scene) => patch.get(scene.id) ?? scene) },
        outline,
        true,
        true,
        () => {}
      );
      const left = qualityIssues(merged);
      if (left.length) {
        console.warn('[生成] 回炉后仍有质量问题，按实际输出继续：' + left.join('；'));
      }
      return merged;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn('[生成] 文稿回炉失败，沿用上一版：' + reason);
      return result;
    }
  }

  /**
   * 重写一轮后再看结果：字数仍不达标时不再阻断发布，按实际输出继续并记警告；
   * 块数属于结构问题，仍严格校验
   */
  private settleScript(pool: unknown, outline: PackOutline, relaxed: boolean): ScriptResult {
    try {
      return normalizeScripts(pool, outline, relaxed);
    } catch (error) {
      if (error instanceof ScriptLengthError) {
        console.warn('[生成] 文稿字数仍不达规范，按实际输出继续：' + error.message);
        return normalizeScripts(pool, outline, true, true);
      }
      throw error;
    }
  }

  private async chatJson(messages: ChatMessage[]): Promise<unknown> {
    const first = await this.request(messages);
    try {
      return parseJson(first);
    } catch {
      const second = await this.request([
        ...messages,
        { role: 'assistant', content: first },
        {
          role: 'user',
          content: '上面的内容不是合法 JSON 对象。请只输出 JSON，不要解释，不要 Markdown 代码块。'
        }
      ]);
      try {
        return parseJson(second);
      } catch {
        throw new Error('文稿生成失败：模型返回的不是合法 JSON');
      }
    }
  }

  private async request(messages: ChatMessage[]): Promise<string> {
    if (!this.options.apiKey) {
      throw new Error('未配置生成服务（缺少 LLM_API_KEY）');
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
        temperature: 0.8,
        max_tokens: 8000,
        response_format: { type: 'json_object' },
        // 千问混合思考模型：非流式调用下默认不开思考，避免思考占满 max_tokens
        enable_thinking: this.options.enableThinking === true,
        stream: false
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`文稿服务返回 ${res.status}：${detail}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('文稿服务返回空内容');
    return content;
  }
}

function throwIfInsufficient(pool: unknown): void {
  const record = asRecord(pool);
  if (record.error) {
    const message = text(record.error);
    throw new Error(message === '资料不足' ? '资料不足，暂不支持该景物' : message);
  }
}

function normalizeOutline(pool: unknown, topic: string): PackOutline {
  const record = asRecord(pool);
  const rawScenes = Array.isArray(record.scenes) ? record.scenes : [];
  if (!rawScenes.length) throw new Error('大纲缺少 scenes');

  const used = new Set<string>();
  const scenes: SceneOutline[] = rawScenes.map((item, index) => {
    const raw = asRecord(item);
    const title = text(raw.title);
    if (!title) throw new Error(`第 ${index + 1} 幕缺少 title`);

    let id = slug(raw.id, 'scene-' + (index + 1));
    while (used.has(id)) id = id + '-' + (index + 1);
    used.add(id);

    return {
      id,
      title,
      subtitle: text(raw.subtitle) || title,
      imageAlt: text(raw.imageAlt) || title,
      pose: text(raw.pose) || '',
      brief: text(raw.brief) || title,
      imageQuery: text(raw.imageQuery) || topic + ' ' + title
    };
  });

  const packId = slug(record.id, 'pack-' + Date.now().toString(36));
  const tags = Array.isArray(record.tags)
    ? record.tags.map((tag) => text(tag)).filter(Boolean).slice(0, 5)
    : [];

  return {
    id: packId,
    title: clampText(text(record.title) || topic, 20),
    subtitle: clampText(text(record.subtitle) || '', 30),
    summary: clampText(text(record.summary) || '', 60),
    tags,
    scenes
  };
}

export function normalizeScripts(
  pool: unknown,
  outline: PackOutline,
  relaxed = false,
  warnOnly = false,
  warn: (message: string) => void = (message) => console.warn(message)
): ScriptResult {
  const blockMin = relaxed ? RELAXED_BLOCK_MIN : BLOCK_MIN;
  const blockMax = relaxed ? RELAXED_BLOCK_MAX : BLOCK_MAX;
  const screenMin = relaxed ? RELAXED_SCREEN_MIN : SCREEN_MIN;
  const screenMax = relaxed ? RELAXED_SCREEN_MAX : SCREEN_MAX;
  /** 兜底档只记警告，不再因字数阻断发布 */
  const lengthIssue = (message: string) => {
    if (warnOnly) {
      warn('[生成] ' + message);
      return;
    }
    throw new ScriptLengthError(message);
  };
  const record = asRecord(pool);
  const rawScenes = Array.isArray(record.scenes) ? record.scenes : [];
  const byId = new Map<string, SceneScript>();

  rawScenes.forEach((item) => {
    const raw = asRecord(item);
    const id = text(raw.id);
    if (!id) return;

    // 正文：字符串或字符串数组都接受，统一成「段间空一行」的 Markdown
    const rawBody = Array.isArray(raw.body)
      ? raw.body.map((part) => text(part)).filter(Boolean).join('\n\n')
      : text(raw.body);
    // 块间必须空一行；模型偶尔在块内一句一行——优先按空行分块，
    // 只有空行切不出多块时才退回按所有换行切，避免「4 块被切成 8 块」
    const normalized = rawBody.replace(/\r\n?/g, '\n');
    const tidy = (part: string): string => part.replace(/[ \t]+/g, ' ').trim();
    const byBlank = normalized.split(/\n{2,}/).map(tidy).filter(Boolean);
    const paragraphs =
      byBlank.length >= 2
        ? byBlank
        : normalized.split(/\n+/).map(tidy).filter(Boolean);
    const body = paragraphs.join('\n\n');

    const transition = text(raw.transition);
    const holdMs = Number(raw.holdMs);

    byId.set(id, {
      id,
      body,
      transition: TRANSITIONS.includes(transition) ? transition : 'fade',
      holdMs: Number.isFinite(holdMs) ? Math.min(10000, Math.max(8000, Math.round(holdMs))) : 9000,
      sources: Array.isArray(raw.sources)
        ? raw.sources.map((source) => text(source)).filter(Boolean)
        : [],
      // 配图按正文产出：模型没给就留空，配图阶段回退大纲初值
      imageQuery: text(raw.imageQuery) || undefined,
      imageAlt: text(raw.imageAlt) || undefined
    });
  });

  const scenes = outline.scenes.map((scene) => {
    const script = byId.get(scene.id);
    if (!script) throw new Error(`文稿缺少第「${scene.title}」幕`);
    if (!script.body) {
      throw new Error(`「${scene.title}」缺少正文`);
    }
    const paragraphs = script.body.split('\n\n');
    if (paragraphs.length !== BLOCKS_PER_SCENE) {
      throw new Error(
        `「${scene.title}」正文应为 ${BLOCKS_PER_SCENE} 块（2 屏 × 2 块），实际 ${paragraphs.length} 块`
      );
    }
    const blocks = paragraphs.map(countChars);
    blocks.forEach((chars, i) => {
      if (chars < blockMin || chars > blockMax) {
        lengthIssue(
          `「${scene.title}」第 ${i + 1} 块应为 ${blockMin}–${blockMax} 字，实际 ${chars} 字`
        );
      }
    });
    // 第 1–2 块为第一屏，第 3–4 块为第二屏，各自需落在单屏字数区间
    for (let i = 0; i < BLOCKS_PER_SCENE; i += 2) {
      const screenChars = blocks[i] + blocks[i + 1];
      if (screenChars < screenMin || screenChars > screenMax) {
        lengthIssue(
          `「${scene.title}」第 ${i / 2 + 1} 屏应为 ${screenMin}–${screenMax} 字，实际 ${screenChars} 字`
        );
      }
    }
    return script;
  });

  return { scenes };
}
