import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function runRegistrationChecks(cdp) {
  const evaluate = cdp.evaluate;
  async function waitFor(expression, label, attempts = 100) {
    for (let i = 0; i < attempts; i++) {
      if (await evaluate(expression)) return;
      await delay(250);
    }
    const messages = await evaluate(`({registration:document.getElementById('registerMessage').textContent,login:document.getElementById('authMessage').textContent,storage:document.getElementById('storageStatus').textContent})`);
    throw new Error(label + ': ' + JSON.stringify(messages));
  }
  const sizes = await evaluate(`(() => { const a=document.getElementById('loginButton').getBoundingClientRect(),b=document.getElementById('openRegisterButton').getBoundingClientRect(); return {a:{w:a.width,h:a.height},b:{w:b.width,h:b.height}}})()`);
  assert.deepEqual(sizes.a, sizes.b, 'Login and register bars must be equal size');
  await evaluate(`document.getElementById('openRegisterButton').click()`);
  await waitFor(`location.hash === '#join' && !document.getElementById('registerForm').hidden`, 'Registration did not open');
  for (const width of [1440, 390, 320]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), `${width}px registration overflows`);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await evaluate(`document.getElementById('registerForm').requestSubmit()`);
  assert.ok(await evaluate(`document.getElementById('registerMessage').textContent.includes('称呼')`));
  for (const id of ['registerPassword', 'registerConfirm']) {
    assert.equal(await evaluate(`(() => { const b=document.querySelector('[data-password-target="${id}"]'); b.click(); return document.getElementById('${id}').type; })()`), 'text');
    await evaluate(`document.querySelector('[data-password-target="${id}"]').click()`);
  }
  const password = 'Qa9!' + randomBytes(12).toString('hex');
  await evaluate(`(() => { document.getElementById('registerName').value='界面验收测试';document.getElementById('registerRelation').value='lntano 的网站自动化测试'; document.getElementById('registerPassword').value=${JSON.stringify(password)};document.getElementById('registerConfirm').value='wrong';document.getElementById('registerForm').requestSubmit(); })()`);
  assert.ok(await evaluate(`document.getElementById('registerMessage').textContent.includes('不一样')`));
  if (process.env.TODO_REGISTER_E2E !== '1') {
    await evaluate(`document.getElementById('backToLoginButton').click()`);
    assert.equal(await evaluate(`document.getElementById('registerPassword').value`), '');
    console.log('Edge registration UI: equal bars, navigation, validation, fixed eyes, desktop/mobile layout passed (no cloud write).');
    return;
  }
  await evaluate(`(() => { document.getElementById('registerConfirm').value=${JSON.stringify(password)};document.getElementById('registerForm').requestSubmit();document.getElementById('registerForm').requestSubmit(); })()`);
  await waitFor(`!document.getElementById('registerSuccess').hidden`, 'Real registration failed');
  const username = await evaluate(`document.getElementById('generatedAccount').value`);
  assert.match(username, /^ln_[a-f0-9]{16}$/);
  assert.equal(await evaluate(`document.getElementById('registerPassword').value`), '');
  assert.ok(!await evaluate(`JSON.stringify({...localStorage,...sessionStorage}).includes(${JSON.stringify(password)})`), 'Password persisted in browser storage');
  await evaluate(`document.getElementById('useAccountButton').click()`);
  assert.equal(await evaluate(`document.getElementById('loginUsername').value`), username);
  await evaluate(`(() => {document.getElementById('loginPassword').value=${JSON.stringify(password)};document.getElementById('loginForm').requestSubmit();})()`);
  await waitFor(`!document.getElementById('appRoot').hidden && !document.getElementById('addButton').disabled`, 'Generated account cannot log in');
  assert.equal(await evaluate(`document.getElementById('storageStatus').textContent`), '');
  // A harmless test task uses the existing production editor and database path.
  await evaluate(`document.getElementById('addButton').click()`);
  const fields = await evaluate(`Array.from(document.querySelectorAll('#taskDialog input')).map(i=>({id:i.id,type:i.type}))`);
  const titleField = fields.find(i => i.type === 'text');
  assert.ok(titleField, 'Task title field missing');
  const taskTitle = '注册验收-' + randomBytes(4).toString('hex');
  await evaluate(`(() => {document.getElementById(${JSON.stringify(titleField.id)}).value=${JSON.stringify(taskTitle)};document.querySelector('#taskDialog form').requestSubmit();})()`);
  await waitFor(`document.getElementById('taskList').textContent.includes(${JSON.stringify(taskTitle)})`, 'Task did not save');
  await cdp.send('Page.reload');
  await waitFor(`document.getElementById('taskList')?.textContent.includes(${JSON.stringify(taskTitle)})`, 'Task lost after reload');
  await evaluate(`document.getElementById('logoutButton').click()`);
  await waitFor(`!document.getElementById('authGate').hidden`, 'Logout failed');
  console.log(JSON.stringify({ registrationE2E: 'passed', username, taskTitle, checks: 'registration, duplicate click, password storage, login, cloud task save, reload, logout' }));
}
