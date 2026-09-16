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
  const chosenUsername = 'test_' + randomBytes(6).toString('hex');
  await evaluate(`(() => { document.getElementById('registerName').value='界面验收测试';document.getElementById('registerRelation').value='lntano 的网站自动化测试';document.getElementById('registerUsername').value=${JSON.stringify(chosenUsername)};document.getElementById('registerPassword').value=${JSON.stringify(password)};document.getElementById('registerConfirm').value='wrong';document.getElementById('registerForm').requestSubmit(); })()`);
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
  assert.equal(username, chosenUsername);
  assert.equal(await evaluate(`document.getElementById('registerPassword').value`), '');
  assert.ok(!await evaluate(`JSON.stringify({...localStorage,...sessionStorage}).includes(${JSON.stringify(password)})`), 'Password persisted in browser storage');
  await evaluate(`document.getElementById('useAccountButton').click()`);
  assert.equal(await evaluate(`document.getElementById('loginUsername').value`), username);
  await evaluate(`(() => {document.getElementById('loginPassword').value=${JSON.stringify(password)};document.getElementById('loginForm').requestSubmit();})()`);
  await waitFor(`!document.getElementById('appRoot').hidden && !document.getElementById('addButton').disabled`, 'Generated account cannot log in');
  assert.equal(await evaluate(`document.getElementById('storageStatus').textContent`), '');
  await waitFor(`!document.querySelector('.companion-layer').hidden`, 'Companion did not appear after login');
  assert.ok(await evaluate(`(() => { const image = document.querySelector('.companion-sprite').style.backgroundImage; return image && image !== 'none' && (image.includes('oneko') || image.includes('data:image')); })()`), 'Companion sprite is missing');
  await waitFor(`document.querySelectorAll('.companion-petal[data-kind="ambient"]').length > 0`, 'Ambient petals did not start');
  const petBefore = await evaluate(`(() => { const pet = document.querySelector('.companion-pet'); const rect = pet.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2, tag: pet.tagName, label: pet.getAttribute('aria-label') }; })()`);
  assert.ok(petBefore.width === 84 && petBefore.height === 84 && petBefore.tag === 'BUTTON' && petBefore.label, 'Companion should be 1.5x larger and accessible');
  const dragTarget = { x: petBefore.centerX - 140, y: petBefore.centerY - 110 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: petBefore.centerX, y: petBefore.centerY, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragTarget.x, y: dragTarget.y, button: 'left', buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragTarget.x, y: dragTarget.y, button: 'left', buttons: 0, clickCount: 1 });
  const petAfter = await evaluate(`(() => { const rect = document.querySelector('.companion-pet').getBoundingClientRect(); return { left: rect.left, top: rect.top, stored: localStorage.getItem('daily-todo.pet-position.v1') }; })()`);
  assert.ok(petAfter.left < petBefore.left - 100 && petAfter.top < petBefore.top - 70 && petAfter.stored, 'Companion drag or position persistence failed');
  await delay(400);
  await evaluate(`document.querySelector('.companion-pet').click()`);
  await waitFor(`!document.querySelector('.companion-message').hidden && document.querySelector('.companion-message').textContent.length > 0`, 'Clicking companion did not trigger a reply');
  // A harmless test task uses the existing production editor and database path.
  await evaluate(`document.getElementById('addButton').click()`);
  const fields = await evaluate(`Array.from(document.querySelectorAll('#taskDialog input')).map(i=>({id:i.id,type:i.type}))`);
  const titleField = fields.find(i => i.type === 'text');
  assert.ok(titleField, 'Task title field missing');
  const taskTitle = '注册验收-' + randomBytes(4).toString('hex');
  await evaluate(`(() => {document.getElementById(${JSON.stringify(titleField.id)}).value=${JSON.stringify(taskTitle)};document.querySelector('input[name="taskPriority"][value="urgent"]').checked=true;document.getElementById('taskStartTime').value='09:00';document.getElementById('taskEndTime').value='10:30';document.querySelector('#taskDialog form').requestSubmit();})()`);
  await waitFor(`document.getElementById('taskList').textContent.includes(${JSON.stringify(taskTitle)})`, 'Task did not save');
  assert.ok(await evaluate(`document.getElementById('taskList').textContent.includes('紧急 / URGENT') && document.getElementById('taskList').textContent.includes('09:00—10:30')`), 'Task priority or time window missing');
  await evaluate(`(() => { const row = Array.from(document.querySelectorAll('.task-row')).find(item => item.querySelector('.task-title').textContent === ${JSON.stringify(taskTitle)}); row.querySelector('.check').click(); })()`);
  await waitFor(`!document.querySelector('.companion-message').hidden && document.querySelector('.companion-message').textContent.includes('漂亮收尾')`, 'Task completion did not trigger companion feedback');
  assert.ok(await evaluate(`document.querySelectorAll('.companion-petal[data-kind="burst"]').length > 0`), 'Task completion did not trigger petal burst');
  const motionState = await evaluate(`(() => { const button = document.getElementById('motionButton'); button.click(); const off = document.querySelector('.companion-layer').hidden && localStorage.getItem('daily-todo.motion.v1') === 'off'; button.click(); return { off, on: !document.querySelector('.companion-layer').hidden && localStorage.getItem('daily-todo.motion.v1') === 'on' }; })()`);
  assert.deepEqual(motionState, { off: true, on: true }, 'Motion preference toggle failed');
  await cdp.send('Page.reload');
  await waitFor(`document.getElementById('taskList')?.textContent.includes(${JSON.stringify(taskTitle)})`, 'Task lost after reload');
  assert.ok(await evaluate(`document.querySelector('.task-row.done')?.querySelector('.task-title').textContent === ${JSON.stringify(taskTitle)}`), 'Task completion state was lost after reload');
  await evaluate(`document.getElementById('logoutButton').click()`);
  await waitFor(`!document.getElementById('authGate').hidden`, 'Logout failed');
  console.log(JSON.stringify({ registrationE2E: 'passed', username, taskTitle, checks: 'registration, login, cloud task save, companion, petals, motion preference, reload, logout' }));
}
