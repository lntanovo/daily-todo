const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate, register, main } = require('../cloudfunctions/register-friend');
const { signedHeaders } = require('../cloudfunctions/register-friend/cloud-api');
const input = { nickname: '测试朋友', relation: '自动化测试', username: 'friend_2026', password: 'TestOnly9!safe', requestToken: 'a'.repeat(64), website: '' };
const entry = { code: 'RESERVED', username: input.username, uid: 'lnreg_' + 'b'.repeat(48) };
function mocks(code = 'RESERVED') {
  const calls = [];
  return { calls, bindingKey: 'local-test-binding-key',
    rpc: async (name, args) => { calls.push({ name, args }); return name === 'reserve_friend_registration_v2' ? { ...entry, code } : true; },
    createUser: async args => { calls.push({ name: 'CreateUser', args }); return { Data: { Uid: entry.uid } }; },
    findUser: async () => entry.uid
  };
}
test('validation accepts intended fields and rejects malformed inputs', () => {
  assert.ok(validate(input));
  for (const bad of [null, [], {}, { ...input, nickname: 'x' }, { ...input, relation: ' ' }, { ...input, username: 'abcd' }, { ...input, username: 'Friend_2026' }, { ...input, username: '1friend' }, { ...input, requestToken: 'guessable' }, { ...input, website: 'spam' }, { ...input, password: 'alllowercase' }, { ...input, password: '!TestOnly9' }, { ...input, password: 'Aaa123\n' }, { ...input, nickname: 'bad\nname' }]) assert.equal(validate(bad), null);
});
test('validation happens before any privileged operation', async () => {
  const deps = mocks();
  assert.equal((await register({}, deps)).code, 'INVALID');
  assert.equal(deps.calls.length, 0);
});
test('success creates an external CloudBase user, then commits; no password in ledger/result', async () => {
  const deps = mocks();
  const result = await register(input, deps);
  assert.deepEqual(result, { ok: true, username: entry.username });
  assert.equal(deps.calls[1].args.Type, 'externalUser');
  assert.equal(deps.calls[1].args.Password, input.password);
  assert.equal(deps.calls[2].name, 'complete_friend_registration');
  assert.ok(!JSON.stringify([deps.calls[0], deps.calls[2], result]).includes(input.password));
});
for (const code of ['CLOSED', 'RATE_LIMIT', 'DAILY_LIMIT', 'TOTAL_LIMIT', 'BUSY', 'CHANGED', 'USERNAME_TAKEN']) {
  test(`${code} prevents upstream account creation`, async () => {
    const deps = mocks(code);
    assert.equal((await register(input, deps)).code, code);
    assert.equal(deps.calls.length, 1);
  });
}
test('successful retry returns same account without another CreateUser call', async () => {
  const deps = mocks('DONE');
  assert.equal((await register(input, deps)).username, entry.username);
  assert.equal(deps.calls.length, 1);
});
test('duplicate after uncertain timeout recovers exact identity, never resets password', async () => {
  const deps = mocks();
  deps.createUser = async () => { throw Object.assign(new Error('duplicate'), { code: 'FailedOperation.DuplicatedData' }); };
  assert.equal((await register(input, deps)).username, entry.username);
  const collision = mocks();
  collision.createUser = deps.createUser;
  collision.findUser = async () => undefined;
  assert.equal((await register(input, collision)).code, 'USERNAME_TAKEN');
  assert.equal(collision.calls.at(-1).name, 'cancel_friend_registration');
});
test('upstream failure never marks a pending record successful', async () => {
  const deps = mocks();
  deps.createUser = async () => { throw new Error('timeout'); };
  await assert.rejects(register(input, deps));
  assert.equal(deps.calls.length, 1);
});
test('input binding detects changed passwords without storing plaintext', async () => {
  const first = mocks(), second = mocks();
  await register(input, first);
  await register({ ...input, password: 'Changed9!safe' }, second);
  assert.equal(first.calls[0].args.p_request_hash, second.calls[0].args.p_request_hash);
  assert.notEqual(first.calls[0].args.p_payload_hash, second.calls[0].args.p_payload_hash);
  const third = mocks();
  await register({ ...input, username: 'another_name' }, third);
  assert.notEqual(first.calls[0].args.p_payload_hash, third.calls[0].args.p_payload_hash);
});
test('runtime rejects a deployment missing server secrets', async () => {
  assert.equal((await main(input, {})).code, 'CLOSED');
});
test('TC3 signature is stable and includes temporary session token', () => {
  const creds = { secretId: 'test-id', secretKey: 'test-secret', token: 'test-session' };
  const h = signedHeaders('CreateUser', '{}', creds, 1700000000);
  assert.match(h.Authorization, /Credential=test-id\/2023-11-14\/tcb\/tc3_request/);
  assert.equal(h['X-TC-Token'], 'test-session');
  assert.deepEqual(h, signedHeaders('CreateUser', '{}', creds, 1700000000));
  assert.notEqual(h.Authorization, signedHeaders('CreateUser', '{"x":1}', creds, 1700000000).Authorization);
});
