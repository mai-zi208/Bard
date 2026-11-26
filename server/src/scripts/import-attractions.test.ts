import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRow,
  cleanAddress,
  cleanIntro,
  cleanName,
  introLength,
  originalImageUrl,
  parseCsv,
  parseImages,
  parseTicket
} from './import-attractions.ts';

test('parseCsv：字段内含换行、转义引号与逗号', () => {
  const rows = parseCsv('名字,地址\n白马寺,"河南省\n洛阳市""古城""东,郊"\n龙门石窟,洛龙区\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][1], '河南省\n洛阳市"古城"东,郊');
  assert.deepEqual(rows[2], ['龙门石窟', '洛龙区']);
});

test('cleanName：剥拉丁词保留中文与数字', () => {
  assert.equal(cleanName('龙门石窟Longmen Grottoes'), '龙门石窟');
  assert.equal(cleanName('798艺术区'), '798艺术区');
  assert.equal(cleanName(' 白马寺 '), '白马寺');
  assert.equal(cleanName('White Horse Temple'), 'White Horse Temple', '纯英文名剥空时回退原名');
});

test('cleanIntro：去 URL 与标签行、压缩空行', () => {
  const raw = '龙门石窟是世界文化遗产。\n\n\n地址:\nhttp://www.lmsk.cn/\n官网:\n以伊河为界。';
  const cleaned = cleanIntro(raw);
  assert.ok(!cleaned.includes('http'));
  assert.ok(!/地址\s*:/.test(cleaned));
  assert.ok(!cleaned.includes('\n\n\n'));
  assert.ok(cleaned.includes('以伊河为界'));
});

test('cleanAddress：只取地址块，丢弃电话与官网', () => {
  const raw = '\n\n地址:\n河南省洛阳市洛龙区龙门中街13号\n\n电话:\n0379-65980972\n\n官网:\nhttp://www.lmsk.cn/';
  assert.equal(cleanAddress(raw), '河南省洛阳市洛龙区龙门中街13号');
  assert.equal(cleanAddress('洛阳市老城区XX街'), '洛阳市老城区XX街');
  assert.equal(cleanAddress(''), '');
});

test('parseTicket：dict repr 解析为票种行，非 dict 保留原文', () => {
  const dict = "{'龙门石窟门票成人票\\n\\n': ['¥90起'], '龙门石窟门票优待票\\n\\n': ['¥45起']}";
  const parsed = parseTicket(dict);
  assert.ok(parsed.includes('龙门石窟门票成人票：¥90起'));
  assert.ok(parsed.includes('龙门石窟门票优待票：¥45起'));
  assert.equal(parseTicket('15元'), '15元');
  assert.equal(parseTicket(''), '');
});

test('parseImages 与 originalImageUrl：缩略图后缀剥除', () => {
  const thumb = 'https://tr-osdcp.qunarzz.com/tr-osd-tr-mapi/img/423e.jpg_480x360x95_29932edd.jpg';
  assert.deepEqual(parseImages(thumb), [thumb]);
  assert.deepEqual(parseImages(''), []);
  assert.equal(
    originalImageUrl(thumb),
    'https://tr-osdcp.qunarzz.com/tr-osd-tr-mapi/img/423e.jpg'
  );
  assert.equal(originalImageUrl('https://a.com/b.jpg'), 'https://a.com/b.jpg');
});

test('buildRow：洛阳龙门石窟整行清洗与季节去重', () => {
  const tips = '龙门石窟最佳旅游时间：4月--11月 一年四季都适合。门票可作为明信片邮寄。';
  const record = [
    '龙门石窟Longmen Grottoes',
    'http://travel.qunar.com/p-oi710400-longmenshiku',
    '\n地址:\n河南省洛阳市洛龙区龙门中街13号\n\n电话:\n0379-65980972',
    '龙门石窟位列世界文化遗产名录。' + '以伊河为界，石窟分为西山和东山两部分。'.repeat(30),
    '08:00-18:00',
    'https://img.qunarzz.com/a.jpg_480x360x95_1.jpg',
    '4.7',
    '建议游览时间：3小时 - 5小时',
    '龙门石窟最佳旅游时间：4月--11月 一年四季都适合。',
    "{'成人票': ['¥90起']}",
    tips,
    '1'
  ];
  const row = buildRow('洛阳', record);
  assert.ok(row);
  assert.equal(row.nameCn, '龙门石窟');
  assert.equal(row.nameNorm, '龙门石窟');
  assert.equal(row.city, '洛阳');
  assert.equal(row.address, '河南省洛阳市洛龙区龙门中街13号');
  assert.ok(row.introLen > 400);
  assert.equal(row.season, '', '季节文本已含于小贴士时置空');
  assert.equal(row.rating, '4.7');
  assert.deepEqual(JSON.parse(row.images), ['https://img.qunarzz.com/a.jpg_480x360x95_1.jpg']);
  assert.equal(row.link, 'http://travel.qunar.com/p-oi710400-longmenshiku');
});

test('buildRow：空名字与归一化空的名字跳过', () => {
  assert.equal(buildRow('洛阳', ['', '', '', '', '', '', '', '', '', '', '', '']), null);
  assert.equal(buildRow('洛阳', ['  ', '', '', '', '', '', '', '', '', '', '', '']), null);
});

test('introLength：按去空白字数统计', () => {
  assert.equal(introLength('龙门 石窟\n是世界遗产'), 9);
});
