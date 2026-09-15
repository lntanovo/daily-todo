const { createHash, createHmac } = require('node:crypto');
const { cloudApi, credentials } = require('./cloud-api');
const messages = {
  CLOSED: '注册暂时关闭，请联系 lntano。',
  RATE_LIMIT: '现在提交的人有点多，请一分钟后再试。',
  DAILY_LIMIT: '今天的注册名额已用完，请明天再来，或联系 lntano。',
  TOTAL_LIMIT: '当前注册名额已满，请联系 lntano。',
  BUSY: '上一次请求还在处理中，请保留此页面，90 秒后再试。',
  CHANGED: '这次填写与上次提交不一致。请恢复原来的称呼、关系和密码后重试，或联系 lntano。',
  INVALID: '请检查称呼、关系和密码格式。',
  UNAVAILABLE: '暂时无法确认注册结果，请保留此页面，90 秒后用原来的信息重试。'
};
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (typeof input.nickname !== 'string' || typeof input.relation !== 'string' || typeof input.password !== 'string') return null;
  const nickname = input.nickname.trim(), relation = input.relation.trim(), password = input.password;
  if (nickname.length < 2 || nickname.length > 32 || relation.length < 1 || relation.length > 80 || /[\x00-\x1f\x7f]/.test(nickname + relation)) return null;
  if (!/^[a-f0-9]{64}$/.test(input.requestToken || '') || input.website) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9()!@#$%^&*|?><_-]{7,31}$/.test(password)) return null;
  if ([/[a-z]/, /[A-Z]/, /[0-9]/, /[()!@#$%^&*|?><_-]/].filter(p => p.test(password)).length < 3) return null;
  return { nickname, relation, password, requestToken: input.requestToken };
}
async function rpc(name, args) {
  const response = await fetch(`https://${process.env.APP_ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/${name}`, {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.CLOUDBASE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw Object.assign(new Error('DATABASE_UNAVAILABLE'), { code: 'DATABASE_UNAVAILABLE' });
  return response.json();
}
const failure = code => ({ ok: false, code, message: messages[code] || messages.UNAVAILABLE });

async function register(input, deps) {
  const data = validate(input);
  if (!data) return failure('INVALID');
  const requestHash = createHash('sha256').update(data.requestToken).digest('hex');
  // Keyed binding detects a retry with changed details, without saving a password.
  const payloadHash = createHmac('sha256', deps.bindingKey).update(JSON.stringify([data.nickname, data.relation, data.password])).digest('hex');
  const reservation = await deps.rpc('reserve_friend_registration', { p_request_hash: requestHash, p_payload_hash: payloadHash, p_nickname: data.nickname, p_relation: data.relation });
  if (reservation.code === 'DONE') return { ok: true, username: reservation.username };
  if (reservation.code !== 'RESERVED') return failure(reservation.code);
  // The username AND UID are fixed by the reservation. Retrying can never reset a password.
  let uid;
  try {
    const result = await deps.createUser({ Name: reservation.username, Uid: reservation.uid, Password: data.password, NickName: data.nickname, Type: 'externalUser', UserStatus: 'ACTIVE', Description: 'Daily Todo friend registration' });
    uid = result.Data?.Uid;
  } catch (error) {
    if (error.code !== 'FailedOperation.DuplicatedData') throw error;
    // A prior timed-out call may have succeeded. Only accept our exact reserved identity.
    uid = await deps.findUser(reservation.username, reservation.uid);
  }
  if (uid !== reservation.uid) throw Object.assign(new Error('IDENTITY_MISMATCH'), { code: 'IDENTITY_MISMATCH' });
  if (!await deps.rpc('complete_friend_registration', { p_request_hash: requestHash, p_user_id: uid })) throw new Error('COMPLETION_FAILED');
  return { ok: true, username: reservation.username };
}

exports.main = async (event, context) => {
  const isHttp = typeof event?.httpMethod === 'string';
  const origin = isHttp ? (event.headers?.origin || event.headers?.Origin || '') : '';
  const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean));
  const respond = (data, statusCode = 200) => isHttp ? {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin',
      ...(allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: JSON.stringify(data)
  } : data;
  try {
    if (isHttp) {
      if (origin && !allowedOrigins.has(origin)) return respond(failure('INVALID'), 403);
      if (event.httpMethod === 'OPTIONS') return respond({}, 200);
      if (event.httpMethod !== 'POST') return respond(failure('INVALID'), 405);
      if (typeof event.body !== 'string' || Buffer.byteLength(event.body) > 8192 || event.isBase64Encoded) return respond(failure('INVALID'), 400);
      try { event = JSON.parse(event.body); } catch { return respond(failure('INVALID'), 400); }
    }
    if (!process.env.APP_ENV_ID || !process.env.CLOUDBASE_API_KEY || !process.env.REGISTRATION_BINDING_KEY) return respond(failure('CLOSED'));
    const credential = credentials(context);
    return respond(await register(event, {
      bindingKey: process.env.REGISTRATION_BINDING_KEY, rpc,
      createUser: params => cloudApi('CreateUser', params, credential),
      findUser: async (username, uid) => {
        const result = await cloudApi('DescribeUserList', { UidList: [uid], PageNo: 1, PageSize: 20 }, credential);
        const users = result.Data?.UserList || [];
        return users.find(user => user.Name === username && user.Uid === uid)?.Uid;
      }
    }));
  } catch (error) {
    const code = /^[A-Za-z0-9_.]{1,100}$/.test(error.code || '') ? error.code : 'REGISTRATION_ERROR';
    console.error(JSON.stringify({ operation: 'friend_registration', code }));
    return respond(failure('UNAVAILABLE'));
  }
};
exports.validate = validate;
exports.register = register;
