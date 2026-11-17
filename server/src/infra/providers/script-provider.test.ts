import test from 'node:test';
import assert from 'node:assert/strict';
import type { PackOutline, ScriptResult } from '../../domain/ports.ts';
import { normalizeScripts, qualityIssues, ScriptLengthError } from './script-provider.ts';

/** 每块 30–48 字、同屏两块 70–90 字、全幕 150–170 字（白马寺山门幕原文，36/45/47/40） */
const BLOCK_1 = '这里是白马寺的山门。正中的「白马寺」匾，由中国佛教协会原会长赵朴初题写。';
const BLOCK_2 = '山门开三个门洞，象征佛教的「三解脱门」：空门、无相门、无愿门。跨过这道门，就是把执念放下。';
const BLOCK_3 = '山门前那两匹石马，传说是汉代驮经之马。其实是北宋太师魏咸信墓前的石像，民国二十四年被移到寺前。';
const BLOCK_4 = '白马寺始建于东汉永平十一年，公元六十八年，是佛教传入中国后兴建的第一座官办寺院。';

/** 50 字：超严格上限 48，落在放宽档 25–50 内 */
const OVER = '这里是白马寺的山门，正中的匾额由中国佛教协会原会长赵朴初先生亲笔题写，字迹浑厚，至今悬挂于山门之上。';
/** 27 字：低于严格下限 30，落在放宽档内，用于把放宽档全幕字数压回 180 以下 */
const UNDER = '门前两匹石马，传说是汉代驮经之马，其实是北宋墓前石像。';

function outline(): PackOutline {
  return {
    id: 'baimasi',
    title: '洛阳白马寺',
    subtitle: '',
    summary: '',
    tags: [],
    scenes: [
      {
        id: 's1',
        title: '山门',
        subtitle: '',
        imageAlt: '',
        pose: '',
        brief: '',
        imageQuery: ''
      }
    ]
  };
}

function pool(blocks: string[]): unknown {
  return {
    scenes: [
      {
        id: 's1',
        body: blocks.join('\n\n'),
        transition: 'fade',
        holdMs: 9000
      }
    ]
  };
}

test('固定四块时通过', () => {
  const result = normalizeScripts(pool([BLOCK_1, BLOCK_2, BLOCK_3, BLOCK_4]), outline());

  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].body.split('\n\n').length, 4);
});

test('块数不是四块时报错', () => {
  assert.throws(() => normalizeScripts(pool([BLOCK_1, BLOCK_2, BLOCK_3]), outline()), /正文应为 4 块/);
});

test('单块超过 48 字时报错', () => {
  assert.throws(
    () => normalizeScripts(pool([OVER, BLOCK_2, BLOCK_3, BLOCK_4]), outline()),
    /第 1 块应为 30–48 字/
  );
});

test('字数超出严格区间时抛出可放宽错误，放宽后可通过', () => {
  const input = pool([OVER, BLOCK_2, UNDER, BLOCK_4]);

  assert.throws(() => normalizeScripts(input, outline()), ScriptLengthError);

  const relaxed = normalizeScripts(input, outline(), true);
  assert.equal(relaxed.scenes[0].body.split('\n\n').length, 4);
});

test('兜底档字数不达标时只告警、不阻断', () => {
  const short = '这里是白马寺的山门。正中匾额题字。';
  const input = pool([short, BLOCK_2, BLOCK_3, BLOCK_4]);

  assert.throws(() => normalizeScripts(input, outline(), true), ScriptLengthError);

  const warnings: string[] = [];
  const result = normalizeScripts(input, outline(), true, true, (message) => warnings.push(message));
  assert.equal(result.scenes[0].body.split('\n\n').length, 4);
  assert.equal(warnings.length, 1);
});

/** 质量复核只做机械判断，用构造结果直接验收 */
function scriptOf(...bodies: string[]): ScriptResult {
  return {
    scenes: bodies.map((body, index) => ({
      id: 's' + (index + 1),
      body,
      transition: 'fade',
      holdMs: 9000,
      sources: []
    }))
  };
}

test('白马寺范式正文不触发质量复核', () => {
  assert.deepEqual(qualityIssues(scriptOf([BLOCK_1, BLOCK_2, BLOCK_3, BLOCK_4].join('\n\n'))), []);
});

test('尺寸数据与套语会被指出', () => {
  const issues = qualityIssues(
    scriptOf(
      [
        '九尊大像依山凿石而成，山崖本身就是佛殿。',
        '这是龙门石窟中规模最大的一组摩崖群雕。',
        '居中的卢舍那大佛高达十七米多，仅头部就有四米。',
        '耳长一点九米，比人还高。'
      ].join('\n\n')
    )
  );
  assert.ok(issues.some((issue) => issue.includes('尺寸')));
  assert.ok(issues.some((issue) => issue.includes('规模最大')));
});

test('同块罗列数量会被指出', () => {
  const issues = qualityIssues(
    scriptOf(
      [
        '洞内南北两壁排满小佛，整齐排列。',
        '完工于唐高宗永隆元年，即公元六百八十年。',
        '记录病名四十例，针灸疗法二十种，涉及药物一百七十三种。',
        '每尊小佛只有四厘米高。'
      ].join('\n\n')
    )
  );
  assert.ok(issues.some((issue) => issue.includes('罗列数量')));
});

test('比喻句式超过一次会被指出', () => {
  const issues = qualityIssues(
    scriptOf(
      '塔身高过树梢，比楼还高，站在下面要仰头。\n\n碑石厚实，比门还宽，字口依然清楚。\n\n殿前空地不大，能站十来个人。\n\n院里很静，只听见风声。'
    )
  );
  assert.ok(issues.some((issue) => issue.includes('「比…还…」句式出现 2 次')));
});
