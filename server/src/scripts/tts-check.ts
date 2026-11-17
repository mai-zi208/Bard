import fs from 'node:fs';
import path from 'node:path';
import { config, doubaoConfig } from '../config.ts';
import { DoubaoProvider } from '../infra/providers/doubao-provider.ts';

/**
 * 单幕试听：用与正式生成同长度的一段讲解稿，测合成耗时并落一个 MP3。
 * 用法：server 目录下 npm run tts:check，可选追加自定义文本。
 */
const SAMPLE =
  '这里是丽景门。城门上的匾额高高悬着，抬头就能看见。' +
  '这座城门是洛阳老城的西大门，隋唐时期，这里是宫城与皇城之间的要道。' +
  '武则天在洛阳称帝，把这里改名神都，城门的规制也随之一变。' +
  '如今看到的城楼是后来重修的，站在城门下，仍能想见当年车马往来的景象。';

const text = process.argv.slice(2).join(' ').trim() || SAMPLE;

if (!doubaoConfig.apiKey) {
  console.error('缺少 DOUBAO_TTS_API_KEY，请先在 server/.env 里填写');
  process.exit(1);
}

const provider = new DoubaoProvider(doubaoConfig);
const started = Date.now();
const result = await provider.synthesize(text);
const elapsed = Date.now() - started;

if (!result) {
  console.error('合成失败，检查 Key、音色与资源 ID 是否匹配');
  process.exit(1);
}

const outDir = path.join(config.projectRoot, '.tmp');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'tts-check-' + doubaoConfig.speaker + '.mp3');
fs.writeFileSync(outFile, result.mp3);

console.log('文本字数：' + text.replace(/\s/g, '').length);
console.log('合成耗时：' + (elapsed / 1000).toFixed(2) + 's');
console.log('音频时长：' + result.meta.durSec + 's');
console.log('MP3 大小：' + (result.meta.bytes / 1024).toFixed(1) + 'KB');
console.log('试听文件：' + outFile);
