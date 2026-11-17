import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../db/database.ts';
import { TaskRepository } from './task-repository.ts';

test('阶段变化追加打点，同阶段重复更新不重复记录', () => {
  const db = openDatabase(':memory:');
  const repo = new TaskRepository(db);

  const task = repo.create('洛阳关林', '');
  repo.update(task.id, { status: 'running', stage: '检索资料' });
  repo.update(task.id, { status: 'running', stage: '检索资料', progress: 30 });
  repo.update(task.id, { status: 'done', stage: '完成', progress: 100 });

  const record = repo.find(task.id);
  assert.ok(record);
  assert.deepEqual(
    record.stageLog.map((mark) => mark.stage),
    ['检索资料', '完成']
  );

  const recent = repo.listRecent(10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, task.id);

  db.close();
});
