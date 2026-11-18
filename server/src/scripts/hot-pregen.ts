import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenList, loadHotList, parseArgs } from './hot-common.ts';

/**
 * 热门景点批量预生成：读取 hot-topics.json，逐条 POST /tasks（persona 固定为空，只生成母本），
 * 轮询 GET /tasks/:id 直到 done/failed。服务端已有内置/已发布包时秒回复用，重跑天然幂等。
 * 用法（server 目录）：npm run hot:pregen -- [--url http://127.0.0.1:8788] [--token xxx] [--only 关键词]
 *   [--concurrency 2] [--dry-run] [--resume] [--list 清单路径] [--out 结果路径]
 * 结果文件供 --resume 跳过已成功条目；429（限流/队列满）自动退避重试。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..', '..');
const args = parseArgs(process.argv.slice(2));

const baseUrl = String(args.get('url') ?? 'http://127.0.0.1:8788').replace(/\/+$/, '');
const token = String(args.get('token') ?? process.env.API_TOKEN ?? '');
const listFile = path.resolve(String(args.get('list') ?? path.join(serverRoot, 'hot-topics.json')));
const outFile = path.resolve(String(args.get('out') ?? path.join(serverRoot, 'data', 'hot-pregen-results.json')));
const only = typeof args.get('only') === 'string' ? String(args.get('only')) : '';
const concurrency = Math.max(1, Number(args.get('concurrency') ?? 2));
const pollMs = Math.max(500, Number(args.get('poll-ms') ?? 3000));
const timeoutMs = Math.max(10000, Number(args.get('timeout-ms') ?? 900000));
const retryAfterMs = Math.max(1000, Number(args.get('retry-after-ms') ?? 10000));
const retries = Math.max(1, Number(args.get('retries') ?? 6));
const dryRun = args.get('dry-run') === true;
const resume = args.get('resume') === true;
for (const [name, value] of [
  ['--concurrency', concurrency],
  ['--poll-ms', pollMs],
  ['--timeout-ms', timeoutMs],
  ['--retry-after-ms', retryAfterMs],
  ['--retries', retries]
] as const) {
  if (!Number.isFinite(value)) throw new Error(name + ' 必须是数字');
}

type Outcome = 'done' | 'failed' | 'rejected' | 'timeout' | 'unauthorized' | 'aborted';

interface Item {
  city: string;
  topic: string;
  outcome?: Outcome;
  taskId?: string;
  packId?: string;
  error?: string;
  seconds?: number;
}

interface TaskView {
  status: string;
  stage: string;
  progress: number;
  packId: string;
  error: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 整体终止信号：401 或连不上服务时置位，剩余条目直接记 aborted */
let abortAll = false;

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 提交一个景点；返回 taskId，或需要退避重试 / 直接拒绝 / 整体终止 */
async function submitTopic(topic: string): Promise<{ taskId: string } | { retry: true } | { rejected: string } | { unauthorized: true }> {
  const headers: Record<string, string> = token ? { 'x-api-token': token } : {};
  let res: Awaited<ReturnType<typeof postJson>>;
  try {
    res = await postJson(baseUrl + '/tasks', { topic, persona: '' }, headers);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
      console.error('\n连不上服务：' + baseUrl + '（' + message + '），请确认服务端已启动');
      abortAll = true;
      return { rejected: '服务不可达' };
    }
    return { retry: true };
  }

  if (res.status === 200 && res.json?.taskId) return { taskId: String(res.json.taskId) };
  if (res.status === 401) return { unauthorized: true };
  if (res.status === 400) return { rejected: String(res.json?.error ?? 'topic 被拒绝') };
  // 429（限流/队列满）与其它异常状态一律退避重试
  return { retry: true };
}

/** 轮询任务直到终态；done 在首轮即返回时视为复用了已有包 */
async function pollTopic(taskId: string, label: string): Promise<{ outcome: Outcome; packId?: string; error?: string }> {
  const started = Date.now();
  let lastStage = '';
  let firstPoll = true;

  while (!abortAll) {
    if (Date.now() - started > timeoutMs) return { outcome: 'timeout', error: '超过 ' + Math.round(timeoutMs / 60000) + ' 分钟未完成' };

    let view: TaskView | null = null;
    try {
      const res = await fetch(baseUrl + '/tasks/' + taskId);
      if (res.ok) view = (await res.json()) as TaskView;
    } catch {
      // 轮询瞬时失败不致命，下一轮再试
    }

    if (view) {
      if (view.status === 'done') {
        console.log(label + ' ✓ done' + (firstPoll ? '（复用已有包）' : '') + ' pack=' + view.packId + ' ' + Math.round((Date.now() - started) / 1000) + 's');
        return { outcome: 'done', packId: view.packId };
      }
      if (view.status === 'failed') {
        console.log(label + ' ✗ failed：' + (view.error || '未知错误'));
        return { outcome: 'failed', error: view.error };
      }
      if (view.stage && view.stage !== lastStage) {
        lastStage = view.stage;
        console.log(label + ' → ' + view.stage + ' ' + view.progress + '%');
      }
    }
    firstPoll = false;
    await sleep(pollMs);
  }

  return { outcome: 'aborted' };
}

async function runItem(item: Item, label: string): Promise<void> {
  const started = Date.now();
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (abortAll) {
      item.outcome = 'aborted';
      return;
    }
    const submit = await submitTopic(item.topic);
    if ('taskId' in submit) {
      item.taskId = submit.taskId;
      const poll = await pollTopic(submit.taskId, label);
      item.outcome = poll.outcome;
      item.packId = poll.packId;
      item.error = poll.error;
      item.seconds = Math.round((Date.now() - started) / 1000);
      return;
    }
    if ('unauthorized' in submit) {
      console.error('\n提交被拒（401）：请核对 --token 与服务端 API_TOKEN 配置，终止整个批次');
      abortAll = true;
      item.outcome = 'unauthorized';
      return;
    }
    if ('rejected' in submit) {
      item.outcome = 'rejected';
      item.error = submit.rejected;
      item.seconds = Math.round((Date.now() - started) / 1000);
      console.log(label + ' ⚠ rejected：' + submit.rejected + '（清单名疑似写错，不重试）');
      return;
    }
    console.log(label + ' 提交被限流/暂不可用，' + Math.round(retryAfterMs / 1000) + ' 秒后重试（' + attempt + '/' + retries + '）');
    await sleep(retryAfterMs);
  }
  item.outcome = 'failed';
  item.error = '持续限流，重试 ' + retries + ' 次仍未提交成功';
  console.log(label + ' ✗ ' + item.error);
}

// —— 主流程 ——
const list = loadHotList(listFile);
let items = flattenList(list).map((entry) => ({ ...entry }) as Item);

if (only) {
  items = items.filter((item) => item.topic.includes(only) || item.city.includes(only));
}

if (resume && fs.existsSync(outFile)) {
  const prev = JSON.parse(fs.readFileSync(outFile, 'utf8')) as { items?: Item[] };
  const doneTopics = new Set((prev.items ?? []).filter((i) => i.outcome === 'done').map((i) => i.topic));
  const skipped = items.filter((i) => doneTopics.has(i.topic)).length;
  items = items.filter((i) => !doneTopics.has(i.topic));
  if (skipped) console.log('resume：跳过结果文件中已完成的 ' + skipped + ' 个条目');
}

if (!items.length) {
  console.log('没有待处理条目（检查 --only 过滤与 --resume）');
  process.exit(0);
}

console.log('服务地址：' + baseUrl + (token ? '（带提交令牌）' : '（无令牌）'));
console.log('待处理 ' + items.length + ' 个景点，并发 ' + concurrency + '：' + items.map((i) => i.topic).join('、'));

if (dryRun) {
  console.log('--dry-run：仅打印计划，不提交');
  process.exit(0);
}

const total = items.length;
let next = 0;
let doneCount = 0;
const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
  while (next < total && !abortAll) {
    const index = next;
    next += 1;
    const item = items[index];
    const label = '[' + (index + 1) + '/' + total + '] ' + item.topic + '（' + item.city + '）';
    await runItem(item, label);
    if (item.outcome === 'done') doneCount += 1;
  }
});
await Promise.all(workers);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(
  outFile,
  JSON.stringify({ ranAt: new Date().toISOString(), url: baseUrl, items }, null, 2) + '\n',
  'utf8'
);

const count = (outcome: Outcome): number => items.filter((i) => i.outcome === outcome).length;
console.log(
  '\n汇总：done ' + doneCount +
    ' / failed ' + count('failed') +
    ' / rejected ' + count('rejected') +
    ' / timeout ' + count('timeout') +
    ' / aborted ' + count('aborted') +
    ' / unauthorized ' + count('unauthorized')
);
const problems = items.filter((i) => i.outcome && i.outcome !== 'done');
if (problems.length) {
  console.log('非成功明细：');
  for (const item of problems) {
    console.log('  ' + item.topic + '：' + item.outcome + (item.error ? '（' + item.error + '）' : ''));
  }
  console.log('修清单后可直接重跑（服务端去重保证幂等），或 --only 关键词单挑失败项');
}
console.log('结果已写入：' + outFile);
if (abortAll) process.exit(1);
