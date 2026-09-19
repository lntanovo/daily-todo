export function dateKey(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function monthDays(year, month) {
  const start = new Date(0);
  start.setFullYear(year, month, 1);
  start.setHours(12, 0, 0, 0);
  const offset = (start.getDay() + 6) % 7;
  const end = new Date(start);
  end.setMonth(month + 1, 0);
  return [...Array(offset).fill(null), ...Array.from({ length: end.getDate() }, (_, index) => dateKey(year, month, index + 1))];
}

export function setupCalendar({ button, getSelectedDate, onSelect, countTasks }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'calendar-dialog';
  dialog.setAttribute('aria-labelledby', 'calendarTitle');
  dialog.innerHTML = `<div class="dialog-inner">
    <div class="feature-heading"><h2 id="calendarTitle">选择一天 <small>CALENDAR</small></h2><button type="button" class="icon-button" data-close aria-label="关闭日历">×</button></div>
    <div class="calendar-navigation">
      <button type="button" class="icon-button" data-month-step="-1" aria-label="上个月">←</button>
      <div class="calendar-selects"><label>年份<input id="calendarYear" type="number" min="1" max="9999" step="1" inputmode="numeric"></label><label>月份<select id="calendarMonth">${Array.from({length:12}, (_,i)=>`<option value="${i}">${i+1}月</option>`).join('')}</select></label></div>
      <button type="button" class="icon-button" data-month-step="1" aria-label="下个月">→</button>
    </div>
    <p class="form-error" id="calendarError" role="alert"></p>
    <div class="calendar-weekdays" aria-hidden="true">${['一','二','三','四','五','六','日'].map(d=>`<span>${d}</span>`).join('')}</div>
    <div class="calendar-grid" role="group" aria-label="日期"></div>
    <div class="calendar-footer"><span>圆点表示当天有事项</span><button type="button" class="button" data-today>回到今天</button></div>
  </div>`;
  document.body.append(dialog);
  const yearInput = dialog.querySelector('#calendarYear');
  const monthInput = dialog.querySelector('#calendarMonth');
  const grid = dialog.querySelector('.calendar-grid');
  let year, month;

  function draw(focusDate) {
    yearInput.value = year;
    monthInput.value = month;
    dialog.querySelector('#calendarError').textContent = '';
    const now = new Date();
    const today = dateKey(now.getFullYear(), now.getMonth(), now.getDate());
    const selected = getSelectedDate();
    grid.replaceChildren(...monthDays(year, month).map(key => {
      if (!key) return document.createElement('span');
      const day = document.createElement('button');
      day.type = 'button';
      day.className = 'calendar-day';
      day.dataset.calendarDate = key;
      day.textContent = Number(key.slice(-2));
      day.setAttribute('aria-label', `${key}${countTasks(key) ? '，有事项' : ''}`);
      day.setAttribute('aria-pressed', String(key === selected));
      if (key === today) day.setAttribute('aria-current', 'date');
      if (countTasks(key)) day.classList.add('has-tasks');
      day.addEventListener('click', () => { onSelect(key); dialog.close(); });
      return day;
    }));
    dialog.querySelector('[data-month-step="-1"]').disabled = year === 1 && month === 0;
    dialog.querySelector('[data-month-step="1"]').disabled = year === 9999 && month === 11;
    if (focusDate) grid.querySelector(`[data-calendar-date="${focusDate}"]`)?.focus();
  }
  function changeMonth() {
    const nextYear = Number(yearInput.value);
    if (!Number.isInteger(nextYear) || nextYear < 1 || nextYear > 9999) {
      dialog.querySelector('#calendarError').textContent = '请输入 1—9999 之间的年份。';
      return;
    }
    const nextMonth = Number(monthInput.value);
    // Enter followed by blur can emit change twice. Do not replace the date
    // button between pointerdown and click when the displayed month is unchanged.
    if (year === nextYear && month === nextMonth) {
      dialog.querySelector('#calendarError').textContent = '';
      return;
    }
    year = nextYear;
    month = nextMonth;
    draw();
  }
  yearInput.addEventListener('change', changeMonth);
  yearInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); changeMonth(); } });
  monthInput.addEventListener('change', changeMonth);
  dialog.querySelectorAll('[data-month-step]').forEach(control => control.addEventListener('click', () => {
    const next = year * 12 + month + Number(control.dataset.monthStep);
    year = Math.floor(next / 12); month = next % 12; draw();
  }));
  grid.addEventListener('keydown', event => {
    const key = event.target.dataset.calendarDate;
    const delta = {ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key];
    if (!key || !delta) return;
    event.preventDefault();
    const next = new Date(`${key}T12:00:00`);
    next.setDate(next.getDate() + delta);
    if (next.getFullYear() < 1 || next.getFullYear() > 9999) return;
    year = next.getFullYear(); month = next.getMonth(); draw(dateKey(year, month, next.getDate()));
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-today]').addEventListener('click', () => {
    const now = new Date(); onSelect(dateKey(now.getFullYear(), now.getMonth(), now.getDate())); dialog.close();
  });
  button.addEventListener('click', () => {
    const selected = getSelectedDate();
    year = Number(selected.slice(0,4)); month = Number(selected.slice(5,7)) - 1;
    draw(); dialog.showModal(); grid.querySelector('[aria-pressed="true"]')?.focus();
  });
  dialog.addEventListener('close', () => button.focus({preventScroll:true}));
}
