import type { ResearchMaterial, ResearchProvider } from '../../domain/ports.ts';
import { suggestAttractions } from '../../domain/services/attraction-index.ts';
import { DESKTOP_UA, MOBILE_UA, fetchText, htmlToText } from './http.ts';

const MIN_CHARS = 800;
const MAX_CHARS = 12000;

/**
 * 资料检索：百度百科移动页为主，Bing 搜索摘要补充。
 * 只负责拿到「可核验的原始文本」，事实取舍交给大纲/文稿模型。
 */
export class BaiduResearchProvider implements ResearchProvider {
  async collect(topic: string, _city?: string): Promise<ResearchMaterial> {
    const references: string[] = [];
    let text = '';

    const baike = await this.fetchBaike(topic);
    if (baike) {
      text = baike.text;
      references.push(baike.url);
    }

    // 百科正文偏薄时才补搜索摘要，避免无关结果污染文稿
    if (text.length < 3000) {
      const snippets = await this.fetchSearchSnippets(topic);
      if (snippets.length) {
        text = [text, snippets.join('\n\n')].filter(Boolean).join('\n\n');
        references.push('https://cn.bing.com/search?q=' + encodeURIComponent(topic));
      }
    }

    text = text.trim().slice(0, MAX_CHARS);

    // 搜索引擎会把错别字「纠正」成真实景点的资料（如「龙马石窟」返回龙门石窟内容）：
    // 资料正文必须出现主题词（或去行政区前缀的短名），否则视为地名有误，不进入生成
    const flat = text.replace(/\s+/g, '');
    const key = topic.replace(/\s+/g, '');
    const short = key.replace(/^(?:河南省|洛阳市|洛阳)+/, '');
    if (!flat.includes(key) && !(short && flat.includes(short))) {
      // 地名可能有误时，用全国景点候选集给出「您是不是要找」建议
      const [suggestion] = suggestAttractions(topic);
      if (suggestion) {
        throw new Error(
          `未检索到「${topic}」的资料，请检查地名是否正确；您是不是要找「${suggestion.name}」（${suggestion.city}）？`
        );
      }
      throw new Error(`未检索到「${topic}」的资料，请检查地名是否正确`);
    }

    if (text.length < MIN_CHARS) {
      throw new Error('资料不足，暂不支持该景物');
    }

    return { topic, text, references };
  }

  private async fetchBaike(topic: string): Promise<{ url: string; text: string } | null> {
    // 百科词条名常带景区后缀（如「明堂天堂」的词条是「明堂天堂景区」），原名未命中时按后缀变体重试
    for (const name of [topic, topic + '景区', topic + '博物馆', topic + '公园']) {
      const hit = await this.fetchBaikeEntry(name, topic);
      if (hit) return hit;
    }
    return null;
  }

  private async fetchBaikeEntry(name: string, topic: string): Promise<{ url: string; text: string } | null> {
    const url = 'https://wapbaike.baidu.com/item/' + encodeURIComponent(name);
    try {
      const res = await fetchText(url, MOBILE_UA, 20000);
      if (res.status !== 200) return null;

      const text = htmlToText(res.text);
      if (text.length < MIN_CHARS) return null;

      // 词条页开头必须出现主题词，防止跳转到无关词条
      const head = text.slice(0, 300);
      const short = topic.replace(/^(?:河南省|洛阳市|洛阳)/, '');
      if (!head.includes(topic) && !head.includes(short)) return null;

      return { url: res.url, text };
    } catch {
      return null;
    }
  }

  private async fetchSearchSnippets(topic: string): Promise<string[]> {
    const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(topic + ' 历史 介绍');
    try {
      const res = await fetchText(url, DESKTOP_UA, 20000);
      if (res.status !== 200) return [];

      const blocks = [...res.text.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)].slice(0, 5);
      return blocks
        .map((match) => htmlToText(match[0]))
        .map((text) => text.slice(0, 500))
        .filter((text) => text.length > 40);
    } catch {
      return [];
    }
  }
}
