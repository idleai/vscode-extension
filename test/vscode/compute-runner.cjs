'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async (host, config, binding, directory, phase, progress) => {
  const saved = path.join(directory, 'runner.json');
  const rpc = async (method, params) => {
    const result = await host.runners.connection.runner(config, binding, { kind: 'runner', method, params });
    assert.ok(result.response && !result.response.error, 'the runner request succeeded');
    return result.response.result;
  };
  if (phase === 'connect') {
    await progress('runner pairing started');
    await host.runners.connection.connect(config, binding,
      await fs.readFile(path.join(directory, 'runner-invitation.txt'), 'utf8'));
    await progress('runner pairing completed');
    const task = JSON.parse(await fs.readFile(path.join(directory, 'runner-task.json'), 'utf8'));
    const id = await host.runners.start({ config, binding }, task.prompt);
    await progress('runner turn submitted');
    await fs.writeFile(saved, JSON.stringify({ id, marker: task.marker }));
    for (let attempt = 0; attempt < 120; attempt++) {
      const { thread } = await rpc('thread/read', { threadId: id, includeTurns: true });
      const started = thread.turns.some(turn => turn.items.some(item =>
        item.type === 'commandExecution' && item.status === 'inProgress' && item.command.includes(task.marker)));
      if (started) {
        await progress('sandboxed command started before desktop exit');
        return { runnerId: id };
      }
      await pause(1000);
    }
    assert.fail('the configured model started the requested sandbox check within two minutes');
  }
  const { id, marker } = JSON.parse(await fs.readFile(saved, 'utf8'));
  const { thread } = await rpc('thread/resume', { threadId: id });
  const turns = thread.turns;
  assert.ok(turns.length > 0, 'runner history survived desktop exit');
  assert.ok(turns.every(turn => turn.status === 'completed'), 'the runner finished while the desktop was closed');
  const output = turns.flatMap(turn => turn.items).filter(item => item.type === 'commandExecution')
    .map(item => item.aggregatedOutput ?? '').join('\n');
  assert.ok(output.includes(`${marker}:PASS`), 'the native command recorded successful scope and network checks');
  assert.ok(!await fs.access(path.join(config.cwd, 'runner-result.json')).then(() => true, () => false),
    'runner output was written on the compute checkout only');
  const rejected = await host.runners.connection.runner(config, binding,
    { kind: 'runner', method: 'turn/start', params: { threadId: id, input: [], sandboxPolicy: { type: 'dangerFullAccess' } } });
  assert.ok(rejected.response?.error, 'a client cannot widen a saved runner');
  await progress('completed runner restored from native history');
  return { runnerId: id, runnerCompleted: true };
};
