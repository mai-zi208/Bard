import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { openDatabase } from '../infra/db/database.ts';
import { TaskRepository } from '../infra/repositories/task-repository.ts';
import { aggregateGenerateTasks, diffList, loadHotList, parseArgs } from './hot-common.ts';

/**
 * 热门景点统计：从 tasks 表聚合母本生成任务的提交频次，输出 Top-N 参考，
 * 并与人工清单 hot-topics.json 做双向差异提示，供人工确认后更新清单。
 * 用法（server 目录）：npm run hot:stats -- [--limit 2000] [--top 30] [--min-count 3] [--out 候选文件.json]
 * --out 只写候选参考文件，绝不覆盖 hot-topics.json。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

const limit = Number(args.get('limit') ?? 2000);
const top = Number(args.get('top') ?? 30);
const minCount = Number(args.get('min-count') ?? 3);
const outFile = args.get('out');
if (!Number.isFinite(limit) || limit <= 0) throw new Error('--limit 必须是正整数');
if (!Number.isFinite(top) || top <= 0) throw new Error('--top 必须是正整数');

const listFile = path.resolve(here, '..', '..', 'hot-topics.json');

const db = openDatabase(config.dbPath);
try {
  const records = new TaskRepository(db).listRecent(limit);
  const stats = aggregateGenerateTasks(records);

  if (!stats.length) {
    console.log('tasks 表中没有母本生成记录（limit=' + limit + '），无法统计热度');
  } else {
    console.log('提交频次 Top-' + Math.min(top, stats.length) + '（窗口 ' + records.length + ' 条任务，仅计 kind=generate）\n');
    console.log('排名  提交  成功  失败  复用  最近提交            归一景点      原始写法样例');
    stats.slice(0, top).forEach((stat, index) => {
      const when = new Date(stat.lastSubmittedAt).toLocaleString('zh-CN', { hour12: false });
      console.log(
        String(index + 1).padStart(3) + '  ' +
          String(stat.count).padStart(4) + '  ' +
          String(stat.done).padStart(4) + '  ' +
          String(stat.failed).padStart(4) + '  ' +
          String(stat.reused).padStart(4) + '  ' +
          when.padEnd(20) + '  ' +
          stat.key + '  ' + stat.names.join(' / ')
      );
    });
  }

  // 候选参考文件：结构与 hot-topics.json 相同，city 留待人工填写
  if (typeof outFile === 'string' && outFile) {
    const candidate = {
      updated: new Date().toISOString().slice(0, 10),
      cities: [{ city: '待定', topics: stats.slice(0, top).map((stat) => stat.names[0] ?? stat.key) }]
    };
    fs.writeFileSync(outFile, JSON.stringify(candidate, null, 2) + '\n', 'utf8');
    console.log('\n候选参考已写入：' + outFile + '（请人工核对城市与景点名后合并进 hot-topics.json）');
  }

  if (fs.existsSync(listFile)) {
    const list = loadHotList(listFile);
    const { listedButNoSubmit, hotButUnlisted } = diffList(list, stats, minCount);

    console.log('\n—— 与 hot-topics.json 的差异 ——');
    if (listedButNoSubmit.length) {
      console.log('清单有但窗口内零提交（共 ' + listedButNoSubmit.length + ' 个，可能确实冷门或名字写错）：');
      console.log('  ' + listedButNoSubmit.join('、'));
    } else {
      console.log('清单景点在窗口内均有提交记录');
    }
    if (hotButUnlisted.length) {
      console.log('提交 ≥ ' + minCount + ' 次但不在清单（候选补充，共 ' + hotButUnlisted.length + ' 个）：');
      for (const stat of hotButUnlisted) {
        console.log('  ' + stat.count + ' 次：' + (stat.names[0] ?? stat.key));
      }
    } else {
      console.log('没有达到候选门槛（≥' + minCount + ' 次）的清单外景点');
    }
  } else {
    console.log('\n提示：' + listFile + ' 不存在，跳过差异比对');
  }
} finally {
  db.close();
}
