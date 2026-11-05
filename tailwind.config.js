/**
 * Tailwind 预编译配置
 * 背景：原先用 cdn.tailwindcss.com 的浏览器端运行时（libs/tailwindcss.min.js，407KB）
 *       在浏览器里现场生成 CSS，首屏样式要等 JS 下载+执行+扫完 DOM 才出现，
 *       手机上表现为「先白屏/整页缩小错位几秒，随后恢复正常」。
 * 现在改为预编译成静态 css/tailwind.css（29KB），随首屏一起到达。
 * ⚠ 改完任何 HTML/JS 里的 class 后，必须重新编译并提交 css/tailwind.css
 *   （CI 里的「校验 Tailwind 预编译 CSS 与源码一致」一步会拦住漏编译的提交）。
 */
module.exports = {
  content: [
    './*.html',
    './js/**/*.js',
  ],
  // 运行时拼接出来的 class（CLI 扫不到源码里的完整类名）放这里
  safelist: [],
};
