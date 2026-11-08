import { resolveIdentity } from './_access.js';
import { verifySession, readCookie, SESSION_COOKIE } from './_session.js';

// 注入两样东西，**绝不注入密码或密码哈希**：
//   ACCESS_NAME —— 欢迎词用的显示名
//   AUTH_MODE   —— 服务端已经判好的身份状态：
//       'access'  → 有可验签的 Cloudflare Access 身份（正常状态，密码不参与）
//       'session' → 没有 Access 身份，但有有效的密码会话 cookie（兜底已生效）
//       'password'→ 两者都没有 → 客户端要弹密码框
// 密码一旦下发到浏览器，它就不再是秘密了（哈希可离线爆破），
// 所以这里只发「身份状态」，秘密留在服务端。
export async function onRequest(context) {
  const { request, env, next } = context;
  const response = await next();
  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("text/html")) {
    return response;
  }

  let html = await response.text();

  const identity = await resolveIdentity(request);
  const accessName = identity && identity.name ? identity.name : "";

  let authMode = 'password';
  if (identity) {
    authMode = 'access';
  } else {
    const token = readCookie(request, SESSION_COOKIE);
    if (env.PASSWORD && token && await verifySession(env.PASSWORD, token)) {
      authMode = 'session';
    }
  }

  html = html.replace(
    'window.__ENV__.ACCESS_NAME = "{{ACCESS_NAME}}";',
    `window.__ENV__.ACCESS_NAME = ${JSON.stringify(accessName)};`
  );
  html = html.replace(
    'window.__ENV__.AUTH_MODE = "{{AUTH_MODE}}";',
    `window.__ENV__.AUTH_MODE = ${JSON.stringify(authMode)};`
  );

  return new Response(html, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}
