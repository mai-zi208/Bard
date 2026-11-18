/**
 * 游览浮窗问答：只读当前资源包，本地拼装答案。
 * 不发起网络请求、不调用模型，离线包同样可用。
 * 输入：用户问题 + 当前包上下文；输出：一段答复 + 可选跳转动作。
 */

const QUICK = ['怎么走', '周边有什么', '下一幕是什么'];
const MAX_SNIPPET = 96;
const MAX_GRAMS = 12;

const ROUTE_WORDS = [
  '怎么走',
  '路线',
  '顺序',
  '下一幕',
  '下一站',
  '继续',
  '还有几幕',
  '第几幕',
  '走到哪',
  '到哪了',
  '怎么去',
  '往上',
  '往下'
];
const NEARBY_WORDS = [
  '周边',
  '附近',
  '周围',
  '旁边',
  '顺路',
  '还有什么',
  '还有啥',
  '别的',
  '看点',
  '看什么',
  '逛什么'
];
const FOOD_WORDS = ['吃', '美食', '水席', '餐厅', '饭店', '饭馆', '小吃', '饿'];
const NARRATOR_WORDS = ['谁在讲', '谁讲', '讲述人', '谁说的', '讲解人'];
const GREET_WORDS = ['你好', '您好', '在吗', '谢谢', '多谢'];

/** 提问里的常见虚词：先剔除，避免「什么」「怎么」这类片段误命中正文 */
const STOPWORDS = [
  '请问',
  '帮我',
  '介绍一下',
  '介绍',
  '讲解',
  '告诉',
  '想问',
  '想了解',
  '了解',
  '知道',
  '一下',
  '这附近',
  '附近',
  '周边',
  '周围',
  '旁边',
  '顺路',
  '有关',
  '关于',
  '什么',
  '怎么',
  '如何',
  '怎样',
  '哪里',
  '哪儿',
  '哪个',
  '哪些',
  '是不是',
  '有没有',
  '能不能',
  '可以',
  '我想',
  '我要',
  '想看',
  '这个',
  '那个',
  '这座',
  '那座',
  '这里',
  '那里',
  '还有',
  '多少',
  '几幕',
  '第几',
  '下一幕',
  '下一站',
  '继续',
  '往上',
  '往下',
  '路线',
  '顺序',
  '美食',
  '吃饭',
  '吃的',
  '水席',
  '餐厅',
  '饭店',
  '出口',
  '入口',
  '门票',
  '开放时间',
  '几点',
  '你好',
  '您好',
  '谢谢',
  '吗',
  '呢',
  '吧',
  '啊',
  '呀',
  '的',
  '了',
  '是',
  '有',
  '在',
  '和',
  '与',
  '我',
  '你',
  '他',
  '它',
  '这',
  '那',
  '就',
  '都',
  '也',
  '很',
  '太',
  '最',
  '能',
  '要',
  '去',
  '到',
  '从',
  '把',
  '被',
  '给',
  '让',
  '个',
  '座',
  '处'
];

/** Markdown 去标记，保留可读正文 */
function plainText(md) {
  return String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 统一小写并去掉标点空白，便于包含判断 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[，。！？、；：“”‘’（）()《》【】\[\]…—\-_\s]/g, '');
}

function hasAny(text, words) {
  for (let i = 0; i < words.length; i += 1) {
    if (text.indexOf(words[i]) >= 0) return true;
  }
  return false;
}

/** 剔除虚词后取单字与双字片段，作为检索关键词 */
function gramsOf(text) {
  let rest = String(text || '');
  STOPWORDS.forEach((word) => {
    rest = rest.split(word).join('|');
  });

  const seen = {};
  const grams = [];
  rest.split('|').forEach((segment) => {
    if (!segment) return;
    if (segment.length === 1) {
      seen[segment] = true;
      grams.push(segment);
    }
    for (let i = 0; i < segment.length - 1; i += 1) {
      const gram = segment.slice(i, i + 2);
      if (!seen[gram]) {
        seen[gram] = true;
        grams.push(gram);
      }
    }
  });
  return grams.slice(0, MAX_GRAMS);
}

/** 取命中关键词附近的一句摘录 */
function snippetOf(text, grams) {
  const source = String(text || '');
  if (!source) return '';

  let at = -1;
  grams.forEach((gram) => {
    const hit = source.indexOf(gram);
    if (hit >= 0 && (at < 0 || hit < at)) at = hit;
  });

  if (at < 0) {
    return source.length > MAX_SNIPPET ? source.slice(0, MAX_SNIPPET) + '…' : source;
  }

  const start = Math.max(0, at - 28);
  const end = Math.min(source.length, at + 68);
  return (
    (start > 0 ? '…' : '') +
    source.slice(start, end).trim() +
    (end < source.length ? '…' : '')
  );
}

/** 场景索引：标题、副标题与纯文本正文，避免每次提问重复解析整包 */
function buildIndex(scenes) {
  return (Array.isArray(scenes) ? scenes : []).map((scene) => {
    let body = '';
    if (scene.body) {
      body = plainText(scene.body);
    } else {
      // v1 包：合并全部分页与段落，检索不只看第一屏
      const blocks = [];
      const pages = Array.isArray(scene.pages) ? scene.pages : [];
      pages.forEach((page) => {
        if (Array.isArray(page)) blocks.push.apply(blocks, page);
        else if (page && Array.isArray(page.paras)) blocks.push.apply(blocks, page.paras);
      });
      const paragraphs = Array.isArray(scene.paragraphs) ? scene.paragraphs : [];
      body = plainText((blocks.length ? blocks : paragraphs).join(' '));
    }
    return {
      title: scene.title || '',
      subtitle: scene.subtitle || '',
      plain: body
    };
  });
}

function sceneName(scene) {
  if (!scene) return '';
  return scene.subtitle ? scene.title + '（' + scene.subtitle + '）' : scene.title;
}

function routeAnswer(scenes, here) {
  const total = scenes.length;
  const next = scenes[here + 1];
  let text = '你正在第 ' + (here + 1) + ' 幕「' + scenes[here].title + '」，全程 ' + total + ' 幕。';

  if (next) {
    text += '下一幕是「' + sceneName(next) + '」，向上滑动即到。';
  } else {
    text += '已经到最后一幕，点底部「完成游览」即可收尾。';
  }

  return {
    text: text,
    action: next ? { label: '去第 ' + (here + 2) + ' 幕 · ' + next.title, index: here + 1 } : null
  };
}

/** 点位与当前幕的距离：同幕最近，其次按幕号邻近；无 sceneId 排最后 */
function poiDistance(poi, here) {
  const at = Number(poi.sceneIndex);
  return at >= 0 ? Math.abs(at - here) : 99;
}

/** 从点位里挑最近的若干条，可按类型过滤 */
function pickPois(pois, here, type, max) {
  return (Array.isArray(pois) ? pois : [])
    .filter((poi) => poi && poi.name && (!type || poi.type === type))
    .sort((a, b) => poiDistance(a, here) - poiDistance(b, here))
    .slice(0, max);
}

function poiLine(poi) {
  let line = '「' + poi.name + '」';
  if (poi.walk) line += '（' + poi.walk + '）';
  if (poi.desc) line += '：' + poi.desc;
  return line;
}

/** 点位答案统一附带跳转：优先跳到最近且不在当前幕的点位所在幕 */
function poiAnswer(pois, scenes, here, prefix, max) {
  const list = pickPois(pois, here, '', max || 3);
  if (!list.length) return null;

  const text = (prefix || '') + '这一带顺路可看：' + list.map(poiLine).join('；') + '。';
  const target = list.filter((poi) => poi.sceneIndex >= 0 && poi.sceneIndex !== here)[0];
  const next = scenes[here + 1];
  const action = target
    ? { label: '去第 ' + (target.sceneIndex + 1) + ' 幕 · ' + scenes[target.sceneIndex].title, index: target.sceneIndex }
    : next
      ? { label: '去第 ' + (here + 2) + ' 幕 · ' + next.title, index: here + 1 }
      : null;

  return { text: text, action: action };
}

function nearbyAnswer(scenes, here, prefix) {
  const total = scenes.length;
  const from = Math.max(0, here - 1);
  const to = Math.min(total - 1, here + 1);
  const names = [];
  for (let i = from; i <= to; i += 1) {
    names.push((i === here ? '当前 · ' : '') + sceneName(scenes[i]));
  }

  let text = (prefix || '') + '这一带顺路可看：' + names.join(' → ') + '。';
  if (here === total - 1 && here > 0) {
    text += '这是最后一幕，可以回看上一处「' + scenes[here - 1].title + '」。';
  }

  const next = scenes[here + 1];
  return {
    text: text,
    action: next
      ? { label: '去第 ' + (here + 2) + ' 幕 · ' + next.title, index: here + 1 }
      : null
  };
}

function searchAnswer(index, scenes, here, grams) {
  let best = null;
  index.forEach((scene, i) => {
    const title = normalize(scene.title);
    const subtitle = normalize(scene.subtitle);
    const body = normalize(scene.plain);
    let score = 0;

    grams.forEach((gram) => {
      if (!gram) return;
      if (title.indexOf(gram) >= 0) score += 4;
      else if (subtitle.indexOf(gram) >= 0) score += 2;
      else if (body.indexOf(gram) >= 0) score += 1;
    });

    if (score >= 2 && (!best || score > best.score)) {
      best = { index: i, score: score, grams: grams };
    }
  });

  if (!best) return null;

  const scene = scenes[best.index];
  const snippet = snippetOf(index[best.index].plain, best.grams);
  const away = best.index !== here ? '（现在在第 ' + (here + 1) + ' 幕，可跳转过去）' : '';
  return {
    text:
      '第 ' + (best.index + 1) + ' 幕「' + scene.title + '」里讲到：' +
      (snippet || scene.subtitle || '这一处暂时没有更多文字。') + away,
    action:
      best.index !== here
        ? { label: '去第 ' + (best.index + 1) + ' 幕 · ' + scene.title, index: best.index }
        : null
  };
}

function fallback(scenes) {
  const names = scenes.slice(0, 4).map((scene) => '「' + scene.title + '」');
  return {
    text: '没有在包内找到相关讲解。可以问怎么走、周边有什么，或试试这些景物：' + names.join('、') + '。',
    action: null
  };
}

/**
 * 回答一个问题。
 * context: { scenes, current, total, narratorName, packTitle }
 */
function answer(question, context) {
  const scenes = (context && context.scenes) || [];
  if (!scenes.length) {
    return { text: '这个资源包还没有可讲解的内容。', action: null };
  }

  const here = Math.max(0, Math.min(Number(context.current) || 0, scenes.length - 1));
  const q = normalize(question);
  if (!q) {
    return { text: '可以问我怎么走、周边有什么，或直接问某处景物。', action: null };
  }

  if (hasAny(q, GREET_WORDS)) {
    return {
      text: '你好，我是本包向导。可以问路线、周边，也可以直接问某处景物。',
      action: null
    };
  }

  if (hasAny(q, NARRATOR_WORDS)) {
    const name = (context && context.narratorName) || '';
    return {
      text: name ? '本包由' + name + '讲述。' : '本包由现代导游讲述。',
      action: null
    };
  }

  const index = buildIndex(scenes);
  const pois = (context && context.pois) || [];

  if (hasAny(q, ROUTE_WORDS)) return routeAnswer(scenes, here);

  if (hasAny(q, FOOD_WORDS)) {
    const food = pickPois(pois, here, 'food', 3);
    if (food.length) {
      const target = food.filter((poi) => poi.sceneIndex >= 0 && poi.sceneIndex !== here)[0];
      return {
        text: '本包收录的餐饮点位：' + food.map(poiLine).join('；') + '。',
        action: target
          ? {
              label: '去第 ' + (target.sceneIndex + 1) + ' 幕 · ' + scenes[target.sceneIndex].title,
              index: target.sceneIndex
            }
          : null
      };
    }
    const none = nearbyAnswer(scenes, here, '本包没有收录餐饮点位，不替你编。');
    none.action = null;
    return none;
  }

  if (hasAny(q, NEARBY_WORDS)) {
    return poiAnswer(pois, scenes, here, '', 3) || nearbyAnswer(scenes, here, '');
  }

  const grams = gramsOf(q);
  const hit = grams.length ? searchAnswer(index, scenes, here, grams) : null;
  if (hit) return hit;

  return fallback(scenes);
}

module.exports = {
  QUICK: QUICK,
  answer: answer,
  plainText: plainText
};
