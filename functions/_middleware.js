import { sha256 } from '../js/sha256.js';
import { resolveIdentity } from './_access.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const response = await next();
  const contentType = response.headers.get("content-type") || "";
  
  if (contentType.includes("text/html")) {
    let html = await response.text();
    
    // 处理普通密码
    const password = env.PASSWORD || "";
    let passwordHash = "";
    if (password) {
      passwordHash = await sha256(password);
    }
    
    // Cloudflare Access 身份：只有验过签的 JWT 才认。
    // 取不到身份就当没有 —— 页面照旧走原来的密码门，不会把谁挡在外面。
    const identity = await resolveIdentity(request);
    const accessName = identity && identity.name ? identity.name : "";
    
    html = html.replace('window.__ENV__.PASSWORD = "{{PASSWORD}}";', 
      `window.__ENV__.PASSWORD = "${passwordHash}";window.__ENV__.ACCESS_NAME = ${JSON.stringify(accessName)};`);
    
    return new Response(html, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  
  return response;
}