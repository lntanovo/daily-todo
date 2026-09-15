const { createHash, createHmac } = require('node:crypto');
const sha = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

// Read runtime credentials inside EACH Event invocation; never cache temporary keys.
function credentials(context = {}) {
  return {
    secretId: context.TENCENTCLOUD_SECRETID || process.env.TENCENTCLOUD_SECRETID,
    secretKey: context.TENCENTCLOUD_SECRETKEY || process.env.TENCENTCLOUD_SECRETKEY,
    token: context.TENCENTCLOUD_SESSIONTOKEN || process.env.TENCENTCLOUD_SESSIONTOKEN
  };
}

function signedHeaders(action, body, credential, timestamp = Math.floor(Date.now() / 1000)) {
  if (!credential.secretId || !credential.secretKey) throw Object.assign(new Error('CREDENTIALS_UNAVAILABLE'), { code: 'CREDENTIALS_UNAVAILABLE' });
  const host = 'tcb.tencentcloudapi.com';
  const contentType = 'application/json; charset=utf-8';
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/tcb/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:${contentType}\nhost:${host}\n\ncontent-type;host\n${sha(body)}`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha(canonical)}`;
  const key = hmac(hmac(hmac('TC3' + credential.secretKey, date), 'tcb'), 'tc3_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return {
    'Content-Type': contentType,
    'X-TC-Action': action,
    'X-TC-Version': '2018-06-08',
    'X-TC-Region': process.env.APP_REGION || 'ap-shanghai',
    'X-TC-Timestamp': String(timestamp),
    ...(credential.token ? { 'X-TC-Token': credential.token } : {}),
    Authorization: `TC3-HMAC-SHA256 Credential=${credential.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`
  };
}

async function cloudApi(action, params, credential) {
  if (!['CreateUser', 'DescribeUserList'].includes(action)) throw new Error('ACTION_NOT_ALLOWED');
  const body = JSON.stringify({ ...params, EnvId: process.env.APP_ENV_ID });
  const response = await fetch('https://tcb.tencentcloudapi.com/', {
    method: 'POST', headers: signedHeaders(action, body, credential), body, signal: AbortSignal.timeout(15000)
  });
  const json = await response.json();
  if (!response.ok || json.Response?.Error || !json.Response) {
    const code = json.Response?.Error?.Code || 'UPSTREAM_FAILED';
    // Error.Message may repeat a submitted password; never propagate it.
    throw Object.assign(new Error(code), { code });
  }
  return json.Response;
}
module.exports = { cloudApi, credentials, signedHeaders };
